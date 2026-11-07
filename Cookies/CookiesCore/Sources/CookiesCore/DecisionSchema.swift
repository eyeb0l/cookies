//
//  DecisionSchema.swift
//  CookiesCore
//
//  The guided-generation schema for one request. `rejectControlId` is an
//  `anyOf` over exactly this request's candidate ids plus "none", so
//  constrained decoding cannot produce any other id.
//

import Foundation

/// Property names and the sentinel, shared by the schema, the engine and the
/// policy (available on every OS so the policy stays testable everywhere).
public enum DecisionFields {
    public static let schemaName = "RejectControlDecision"
    public static let isCookieConsentBanner = "isCookieConsentBanner"
    public static let rejectControlId = "rejectControlId"
    public static let confidence = "confidence"
    public static let reason = "reason"
    /// The model's "no qualifying control" answer.
    public static let noneSentinel = "none"
    public static let confidenceValues = IdentifyRejectControlResult.Confidence.allCases.map(\.rawValue)
}

#if canImport(FoundationModels)
import FoundationModels

@available(macOS 26.0, iOS 26.0, *)
public enum DecisionSchema {
    public enum BuildError: Error, Equatable {
        case noCandidates
    }

    /// Builds the schema for `candidateIds` (already validated: unique,
    /// `^c\d{1,2}$`, so none of them can collide with the sentinel).
    public static func make(candidateIds: [String]) throws -> GenerationSchema {
        guard !candidateIds.isEmpty else { throw BuildError.noCandidates }

        let choices = candidateIds + [DecisionFields.noneSentinel]
        let root = DynamicGenerationSchema(
            name: DecisionFields.schemaName,
            description: "Which candidate control rejects all optional cookies.",
            properties: [
                .init(
                    name: DecisionFields.isCookieConsentBanner,
                    description: "True only if the container is a cookie/privacy consent banner or dialog.",
                    schema: DynamicGenerationSchema(type: Bool.self)
                ),
                .init(
                    name: DecisionFields.rejectControlId,
                    description: "Id of the control that rejects all optional cookies, or none.",
                    schema: DynamicGenerationSchema(
                        name: "CandidateId",
                        description: "A candidate id from the list, or none.",
                        anyOf: choices
                    )
                ),
                .init(
                    name: DecisionFields.confidence,
                    description: "high only if the label unambiguously means reject all or necessary only.",
                    schema: DynamicGenerationSchema(
                        name: "Confidence",
                        anyOf: DecisionFields.confidenceValues
                    )
                ),
                .init(
                    name: DecisionFields.reason,
                    description: "One short English sentence.",
                    schema: DynamicGenerationSchema(type: String.self)
                ),
            ]
        )
        return try GenerationSchema(root: root, dependencies: [])
    }
}
#endif
