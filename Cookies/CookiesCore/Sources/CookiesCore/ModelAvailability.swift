//
//  ModelAvailability.swift
//  CookiesCore
//
//  Whether the on-device language model can be used right now. Compiled into
//  the extension (for `ping`/`availability` messages) and into the container
//  app (to tell the user what to do).
//

import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

public struct ModelAvailabilityStatus: Sendable, Equatable {
    public enum Reason: String, Sendable, CaseIterable {
        case available
        case deviceNotEligible = "device-not-eligible"
        case appleIntelligenceNotEnabled = "apple-intelligence-not-enabled"
        case modelNotReady = "model-not-ready"
        case unknown
        /// OS older than macOS 26 / iOS 26.
        case osUnsupported = "os-unsupported"
        /// Built against an SDK without FoundationModels.
        case frameworkUnavailable = "framework-unavailable"
    }

    public let reason: Reason
    public var available: Bool { reason == .available }
    public var osSupported: Bool { reason != .osUnsupported && reason != .frameworkUnavailable }

    public init(reason: Reason) {
        self.reason = reason
    }

    /// `{ type: "availability", available, reason, osSupported }`
    public var dictionary: [String: Any] {
        [
            "type": "availability",
            "available": available,
            "reason": reason.rawValue,
            "osSupported": osSupported,
        ]
    }
}

public enum ModelAvailability {
    /// Reads `SystemLanguageModel.default.availability`. Cheap; does not load
    /// the model.
    public static func current() -> ModelAvailabilityStatus {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return ModelAvailabilityStatus(reason: .available)
            case .unavailable(let reason):
                switch reason {
                case .deviceNotEligible: return ModelAvailabilityStatus(reason: .deviceNotEligible)
                case .appleIntelligenceNotEnabled: return ModelAvailabilityStatus(reason: .appleIntelligenceNotEnabled)
                case .modelNotReady: return ModelAvailabilityStatus(reason: .modelNotReady)
                @unknown default: return ModelAvailabilityStatus(reason: .unknown)
                }
            }
        } else {
            return ModelAvailabilityStatus(reason: .osUnsupported)
        }
        #else
        return ModelAvailabilityStatus(reason: .frameworkUnavailable)
        #endif
    }
}
