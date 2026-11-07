//
//  RejectControlClassifier.swift
//  CookiesCore
//
//  The engine abstraction and its FoundationModels implementation. Engines
//  only report what the model said; `DecisionPolicy` decides whether that is
//  good enough to click.
//

import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// What an engine produced for one request. A plain value so tests can inject
/// any outcome.
public struct RawDecision: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        /// The model answered; fields below are its raw output.
        case answered
        /// The model cannot be used (OS, device, settings, assets).
        case unavailable
        /// Generation failed or timed out.
        case failed
    }

    public var kind: Kind
    public var isCookieConsentBanner: Bool
    /// A candidate id or `DecisionFields.noneSentinel`, unvalidated.
    public var rejectControlId: String
    /// `"high" | "medium" | "low"` as generated, unvalidated.
    public var confidence: String
    /// The model's reason, or a terse failure/unavailability code.
    public var reason: String

    public init(kind: Kind, isCookieConsentBanner: Bool, rejectControlId: String, confidence: String, reason: String) {
        self.kind = kind
        self.isCookieConsentBanner = isCookieConsentBanner
        self.rejectControlId = rejectControlId
        self.confidence = confidence
        self.reason = reason
    }

    public static func answered(isCookieConsentBanner: Bool, rejectControlId: String, confidence: String, reason: String) -> Self {
        Self(kind: .answered, isCookieConsentBanner: isCookieConsentBanner, rejectControlId: rejectControlId, confidence: confidence, reason: reason)
    }

    public static func unavailable(_ reason: String) -> Self {
        Self(kind: .unavailable, isCookieConsentBanner: false, rejectControlId: DecisionFields.noneSentinel, confidence: "low", reason: reason)
    }

    public static func failed(_ reason: String) -> Self {
        Self(kind: .failed, isCookieConsentBanner: false, rejectControlId: DecisionFields.noneSentinel, confidence: "low", reason: reason)
    }
}

/// Something that can propose a reject control for a validated request.
/// Implementations must not throw and should honour task cancellation.
public protocol RejectControlEngine: Sendable {
    func classify(_ request: IdentifyRejectControlRequest) async -> RawDecision
}

/// Apple's on-device model via FoundationModels: one fresh session per
/// request, greedy decoding, schema-constrained output.
public struct FoundationModelsEngine: RejectControlEngine {
    public static let maximumResponseTokens = 160

    public init() {}

    public func classify(_ request: IdentifyRejectControlRequest) async -> RawDecision {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, iOS 26.0, *) {
            return await Self.classifyOnDevice(request)
        }
        return .unavailable(ModelAvailabilityStatus.Reason.osUnsupported.rawValue)
        #else
        return .unavailable(ModelAvailabilityStatus.Reason.frameworkUnavailable.rawValue)
        #endif
    }

    #if canImport(FoundationModels)
    @available(macOS 26.0, iOS 26.0, *)
    static func classifyOnDevice(_ request: IdentifyRejectControlRequest) async -> RawDecision {
        let availability = ModelAvailability.current()
        guard availability.available else { return .unavailable(availability.reason.rawValue) }

        let schema: GenerationSchema
        do {
            schema = try DecisionSchema.make(candidateIds: request.candidates.map(\.id))
        } catch {
            return .failed("schema-build-failed")
        }

        let session = LanguageModelSession(model: SystemLanguageModel.default, instructions: Prompt.instructions)
        // `init(samplingMode:…)` is the non-deprecated spelling of
        // `init(sampling:…)` and is back-deployed to macOS/iOS 26.0.
        let options = GenerationOptions(samplingMode: .greedy, temperature: 0, maximumResponseTokens: maximumResponseTokens)

        do {
            try Task.checkCancellation()
            let response = try await session.respond(
                to: Prompt.render(request),
                schema: schema,
                includeSchemaInPrompt: true,
                options: options
            )
            let content = response.content
            return .answered(
                isCookieConsentBanner: try content.value(Bool.self, forProperty: DecisionFields.isCookieConsentBanner),
                rejectControlId: try content.value(String.self, forProperty: DecisionFields.rejectControlId),
                confidence: try content.value(String.self, forProperty: DecisionFields.confidence),
                reason: try content.value(String.self, forProperty: DecisionFields.reason)
            )
        } catch {
            return .failed(describe(error))
        }
    }

    /// Terse, content-free code for a generation error.
    @available(macOS 26.0, iOS 26.0, *)
    static func describe(_ error: any Error) -> String {
        if error is CancellationError { return "cancelled" }
        if #available(macOS 27.0, iOS 27.0, *) {
            if let error = error as? LanguageModelError {
                switch error {
                case .contextSizeExceeded: return "context-window-exceeded"
                case .rateLimited: return "rate-limited"
                case .guardrailViolation: return "guardrail-violation"
                case .refusal: return "refusal"
                case .unsupportedCapability: return "unsupported-capability"
                case .unsupportedTranscriptContent: return "unsupported-content"
                case .unsupportedGenerationGuide: return "unsupported-guide"
                case .unsupportedLanguageOrLocale: return "unsupported-language"
                case .timeout: return "model-timeout"
                @unknown default: return "generation-failed"
                }
            }
            if error is SystemLanguageModel.Error { return "assets-unavailable" }
            if error is LanguageModelSession.Error { return "session-busy" }
            if error is GeneratedContent.ParsingError { return "decoding-failure" }
        }
        if let error = error as? LanguageModelSession.GenerationError {
            switch error {
            case .exceededContextWindowSize: return "context-window-exceeded"
            case .assetsUnavailable: return "assets-unavailable"
            case .guardrailViolation: return "guardrail-violation"
            case .unsupportedGuide: return "unsupported-guide"
            case .unsupportedLanguageOrLocale: return "unsupported-language"
            case .decodingFailure: return "decoding-failure"
            case .rateLimited: return "rate-limited"
            case .concurrentRequests: return "session-busy"
            case .refusal: return "refusal"
            @unknown default: return "generation-failed"
            }
        }
        return "generation-failed"
    }
    #endif
}
