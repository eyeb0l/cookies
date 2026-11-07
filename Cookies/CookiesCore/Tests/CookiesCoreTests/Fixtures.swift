import Foundation
@testable import CookiesCore

enum Fixtures {
    /// The sample request from docs/ARCHITECTURE.md, as Safari delivers it
    /// (Foundation types, NSNumber booleans).
    static func sampleMessage() -> [String: Any] {
        [
            "type": "identifyRejectControl",
            "version": NSNumber(value: 1),
            "page": ["host": "example.com", "lang": "en", "frame": "top"],
            "container": [
                "tag": "div",
                "role": "dialog",
                "text": "We use cookies to improve your experience. You can accept all cookies, reject them, or choose in settings.",
                "attrs": ["id": "cookie-banner", "class": "cb-root"],
            ] as [String: Any],
            "candidates": [
                ["id": "c1", "tag": "button", "text": "Accept all", "aria": "", "attrs": ["class": "cb-btn primary"], "role": "", "disabled": NSNumber(value: false)],
                ["id": "c2", "tag": "button", "text": "Reject all", "aria": "", "attrs": ["class": "cb-btn"], "role": "", "disabled": NSNumber(value: false)],
                ["id": "c3", "tag": "a", "text": "Cookie settings", "aria": "", "attrs": ["href": "#"], "role": "", "disabled": NSNumber(value: false)],
            ] as [[String: Any]],
        ]
    }

    static func sampleRequest() throws -> IdentifyRejectControlRequest {
        try RequestValidator.validate(message: sampleMessage())
    }

    static func request(candidates: [Candidate], containerText: String = "We use cookies. Manage your consent.") -> IdentifyRejectControlRequest {
        IdentifyRejectControlRequest(
            page: PageInfo(host: "example.com", lang: "en", frame: "top"),
            container: ContainerInfo(tag: "div", role: "dialog", text: containerText, attrs: ["id": "cookie-banner"]),
            candidates: candidates
        )
    }

    static func candidates(_ labels: String...) -> [Candidate] {
        labels.enumerated().map { Candidate(id: "c\($0.offset + 1)", tag: "button", text: $0.element) }
    }
}

/// Engine returning a canned decision, optionally after a delay.
struct FakeEngine: RejectControlEngine {
    var decision: RawDecision
    var delay: Duration? = nil
    var ignoresCancellation = false

    func classify(_ request: IdentifyRejectControlRequest) async -> RawDecision {
        if let delay {
            if ignoresCancellation {
                // Busy-wait on a clock instead of Task.sleep, which would
                // return early on cancellation.
                let deadline = ContinuousClock.now + delay
                while ContinuousClock.now < deadline {
                    await Task.yield()
                    usleep(1_000)
                }
            } else {
                do { try await Task.sleep(for: delay) } catch { return .failed("cancelled") }
            }
        }
        return decision
    }
}

struct EngineFailure: Error {}

/// Engine whose underlying model call throws; mirrors how
/// `FoundationModelsEngine` folds errors into `.failed`.
struct ThrowingEngine: RejectControlEngine {
    func classify(_ request: IdentifyRejectControlRequest) async -> RawDecision {
        do {
            try await underlyingCall()
            return .answered(isCookieConsentBanner: true, rejectControlId: "c2", confidence: "high", reason: "unreachable")
        } catch {
            return .failed("generation-failed")
        }
    }

    private func underlyingCall() async throws { throw EngineFailure() }
}
