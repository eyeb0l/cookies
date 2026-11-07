//
//  CookiesService.swift
//  CookiesCore
//
//  Entry point used by SafariWebExtensionHandler:
//  validate → engine (with timeout) → policy → encode. Never throws; every
//  path produces a well-formed `identifyRejectControlResult`.
//

import Foundation
import os

public final class CookiesService: Sendable {
    public static let shared = CookiesService()
    /// Kept below background.js's 15 s native timeout so the extension gets
    /// a well-formed `"timeout"` error rather than a dropped reply. A warm
    /// on-device call takes 1–4 s.
    public static let defaultTimeout: Duration = .seconds(12)

    private let engine: any RejectControlEngine
    private let timeout: Duration

    public init(engine: any RejectControlEngine = FoundationModelsEngine(), timeout: Duration = CookiesService.defaultTimeout) {
        self.engine = engine
        self.timeout = timeout
    }

    /// Handles the raw `SFExtensionMessageKey` dictionary of an
    /// `identifyRejectControl` message and returns the reply dictionary.
    public func handle(message: [String: Any]) async -> [String: Any] {
        let request: IdentifyRejectControlRequest
        do throws(RequestValidationError) {
            request = try RequestValidator.validate(message: message)
        } catch {
            Log.service.notice("Rejected request: \(error.reason, privacy: .public)")
            return IdentifyRejectControlResult.error(error.reason).dictionary
        }
        return await handle(validated: request).dictionary
    }

    /// Validates and handles a typed request.
    public func handle(request: IdentifyRejectControlRequest) async -> IdentifyRejectControlResult {
        let validated: IdentifyRejectControlRequest
        do throws(RequestValidationError) {
            validated = try RequestValidator.validate(request)
        } catch {
            return .error(error.reason)
        }
        return await handle(validated: validated)
    }

    private func handle(validated request: IdentifyRejectControlRequest) async -> IdentifyRejectControlResult {
        Log.service.info("Classifying \(request.candidates.count, privacy: .public) candidates on \(request.page?.host ?? "?", privacy: .private)")
        let start = ContinuousClock.now
        let engine = self.engine
        let decision = await Self.race(timeout: timeout) { await engine.classify(request) }
        let result = DecisionPolicy.evaluate(decision, for: request)
        let elapsed = ContinuousClock.now - start
        Log.service.info("""
            Result \(result.status.rawValue, privacy: .public) \
            id=\(result.candidateId ?? "-", privacy: .public) \
            confidence=\(result.confidence?.rawValue ?? "-", privacy: .public) \
            in \(elapsed.formatted(.units(allowed: [.milliseconds])), privacy: .public): \
            \(result.reason, privacy: .private)
            """)
        return result
    }

    /// Runs `operation`, but returns `.failed("timeout")` once `timeout`
    /// elapses even if the operation ignores cancellation (it is cancelled
    /// and left to wind down on its own). Exactly one value is returned.
    static func race(timeout: Duration, _ operation: @escaping @Sendable () async -> RawDecision) async -> RawDecision {
        let worker = Task { await operation() }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<RawDecision, Never>) in
                let once = ResumeOnce(continuation)
                let timer = Task {
                    do { try await Task.sleep(for: timeout) } catch { return }
                    if once.resume(returning: .failed("timeout")) { worker.cancel() }
                }
                Task {
                    let decision = await worker.value
                    timer.cancel()
                    once.resume(returning: decision)
                }
            }
        } onCancel: {
            worker.cancel()
        }
    }
}

/// Resumes a continuation at most once, from whichever task gets there first.
private final class ResumeOnce: Sendable {
    private let state: OSAllocatedUnfairLock<CheckedContinuation<RawDecision, Never>?>

    init(_ continuation: CheckedContinuation<RawDecision, Never>) {
        state = OSAllocatedUnfairLock(initialState: continuation)
    }

    /// Returns true if this call resumed the continuation.
    @discardableResult
    func resume(returning value: RawDecision) -> Bool {
        let continuation = state.withLock { state -> CheckedContinuation<RawDecision, Never>? in
            defer { state = nil }
            return state
        }
        continuation?.resume(returning: value)
        return continuation != nil
    }
}
