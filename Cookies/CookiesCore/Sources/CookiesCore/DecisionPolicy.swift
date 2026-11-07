//
//  DecisionPolicy.swift
//  CookiesCore
//
//  Post-validation of the model's answer (docs/ARCHITECTURE.md, step 5).
//  Pure and deterministic. Every check must pass for `.ok`; anything else is
//  `.notConsent`, `.none` or `.uncertain`, never `.ok`.
//

import Foundation

public enum DecisionPolicy {
    public static let maximumReasonLength = 160

    /// Turns an engine outcome into the reply for `request` (which must be
    /// the validated request the engine saw).
    public static func evaluate(_ decision: RawDecision, for request: IdentifyRejectControlRequest) -> IdentifyRejectControlResult {
        switch decision.kind {
        case .unavailable:
            return IdentifyRejectControlResult(status: .unavailable, reason: terse(decision.reason, fallback: "model unavailable"), engine: .none)
        case .failed:
            return IdentifyRejectControlResult(status: .error, reason: terse(decision.reason, fallback: "generation failed"), engine: .foundationModels)
        case .answered:
            return evaluateAnswer(decision, for: request)
        }
    }

    private static func evaluateAnswer(_ decision: RawDecision, for request: IdentifyRejectControlRequest) -> IdentifyRejectControlResult {
        let confidence = IdentifyRejectControlResult.Confidence(rawValue: decision.confidence)
        func reject(_ status: IdentifyRejectControlResult.Status, _ reason: String) -> IdentifyRejectControlResult {
            IdentifyRejectControlResult(status: status, confidence: confidence, reason: reason, engine: .foundationModels)
        }

        // 1. The container must be a consent banner.
        guard decision.isCookieConsentBanner else {
            return reject(.notConsent, "model: not a cookie-consent banner")
        }
        // 2. The model must have picked something.
        guard decision.rejectControlId != DecisionFields.noneSentinel else {
            return reject(.none, "model: no reject control")
        }
        // 3. …and it must be one of this request's candidates. The schema
        //    already guarantees this; re-checking costs nothing.
        guard let candidate = request.candidates.first(where: { $0.id == decision.rejectControlId }) else {
            return reject(.uncertain, "model chose an unknown id")
        }
        // 4. Only high confidence is actionable.
        guard confidence == .high else {
            return reject(.uncertain, "model confidence is \(confidence?.rawValue ?? "unrecognised")")
        }
        // 5. Never press a disabled control.
        guard candidate.disabled != true else {
            return reject(.uncertain, "chosen control is disabled")
        }

        let labels = [candidate.text, candidate.aria].compactMap { $0 }.filter { !Lexicon.normalise($0).isEmpty }
        guard !labels.isEmpty else {
            return reject(.uncertain, "chosen control has no label")
        }
        // 6. No label may read as accepting/agreeing/allowing/continuing.
        guard !labels.contains(where: Lexicon.isAcceptLike) else {
            return reject(.uncertain, "chosen control looks like accept")
        }
        // 7. No label may name a dangerous action (pay, subscribe, log in…).
        guard !labels.contains(where: Lexicon.isDangerous) else {
            return reject(.uncertain, "chosen control looks dangerous")
        }
        // 8. Some label must positively read as reject, or the model must
        //    explain it as the necessary-only option and a label must say
        //    necessary/essential/required.
        let rejectLike = labels.contains(where: Lexicon.isRejectLike)
        let necessaryOnlyByReason = Lexicon.isNecessaryOnly(decision.reason) && labels.contains(where: Lexicon.mentionsNecessary)
        guard rejectLike || necessaryOnlyByReason else {
            return reject(.uncertain, "chosen control does not look like reject")
        }

        return IdentifyRejectControlResult(
            status: .ok,
            candidateId: candidate.id,
            confidence: .high,
            reason: terse(decision.reason, fallback: "reject control identified"),
            engine: .foundationModels
        )
    }

    /// Sanitised, length-capped reason text.
    static func terse(_ reason: String, fallback: String) -> String {
        TextSanitiser.clean(reason, limit: maximumReasonLength) ?? fallback
    }
}
