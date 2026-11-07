//
//  Models.swift
//  CookiesCore
//
//  Wire types for the `identifyRejectControl` exchange described in
//  docs/ARCHITECTURE.md. Raw values of the enums are the exact wire strings.
//

import Foundation

// MARK: - Request (extension → native)

/// Page metadata. Informational only; never used to make a decision.
public struct PageInfo: Codable, Sendable, Equatable {
    public var host: String?
    public var lang: String?
    public var frame: String?

    public init(host: String? = nil, lang: String? = nil, frame: String? = nil) {
        self.host = host
        self.lang = lang
        self.frame = frame
    }
}

/// The consent container the content script found.
public struct ContainerInfo: Codable, Sendable, Equatable {
    public var tag: String?
    public var role: String?
    public var text: String?
    public var attrs: [String: String]?

    public init(tag: String? = nil, role: String? = nil, text: String? = nil, attrs: [String: String]? = nil) {
        self.tag = tag
        self.role = role
        self.text = text
        self.attrs = attrs
    }

    private enum CodingKeys: String, CodingKey { case tag, role, text, attrs }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tag = try c.decodeIfPresent(String.self, forKey: .tag)
        role = try c.decodeIfPresent(String.self, forKey: .role)
        text = try c.decodeIfPresent(String.self, forKey: .text)
        attrs = try c.decodeIfPresent(LossyStringMap.self, forKey: .attrs)?.values
    }
}

/// One button-like control inside the container. `id` is the opaque
/// `c1…cN` handle assigned by the content script.
public struct Candidate: Codable, Sendable, Equatable {
    public var id: String
    public var tag: String?
    public var text: String?
    public var aria: String?
    public var attrs: [String: String]?
    public var role: String?
    public var disabled: Bool?

    public init(
        id: String,
        tag: String? = nil,
        text: String? = nil,
        aria: String? = nil,
        attrs: [String: String]? = nil,
        role: String? = nil,
        disabled: Bool? = nil
    ) {
        self.id = id
        self.tag = tag
        self.text = text
        self.aria = aria
        self.attrs = attrs
        self.role = role
        self.disabled = disabled
    }

    private enum CodingKeys: String, CodingKey { case id, tag, text, aria, attrs, role, disabled }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        tag = try c.decodeIfPresent(String.self, forKey: .tag)
        text = try c.decodeIfPresent(String.self, forKey: .text)
        aria = try c.decodeIfPresent(String.self, forKey: .aria)
        attrs = try c.decodeIfPresent(LossyStringMap.self, forKey: .attrs)?.values
        role = try c.decodeIfPresent(String.self, forKey: .role)
        disabled = try c.decodeIfPresent(Bool.self, forKey: .disabled)
    }
}

/// `{ "type": "identifyRejectControl", "version": 1, … }`
public struct IdentifyRejectControlRequest: Codable, Sendable, Equatable {
    public static let messageType = "identifyRejectControl"
    public static let supportedVersion = 1

    public var type: String
    public var version: Int
    public var page: PageInfo?
    public var container: ContainerInfo?
    public var candidates: [Candidate]

    public init(
        type: String = IdentifyRejectControlRequest.messageType,
        version: Int = IdentifyRejectControlRequest.supportedVersion,
        page: PageInfo? = nil,
        container: ContainerInfo? = nil,
        candidates: [Candidate]
    ) {
        self.type = type
        self.version = version
        self.page = page
        self.container = container
        self.candidates = candidates
    }

    /// Decodes a request from the dictionary Safari delivers under
    /// `SFExtensionMessageKey`.
    ///
    /// The dictionary is round-tripped through `JSONSerialization` so that the
    /// strict, type-checked `JSONDecoder` does the work; nothing is cast by hand.
    /// Messages whose JSON form exceeds `maximumEncodedSize` are refused before
    /// decoding.
    public static func decode(from message: [String: Any]) throws(RequestValidationError) -> IdentifyRejectControlRequest {
        guard JSONSerialization.isValidJSONObject(message) else { throw .malformed("not a JSON object") }
        let data: Data
        do {
            data = try JSONSerialization.data(withJSONObject: message, options: [])
        } catch {
            throw .malformed("not serialisable")
        }
        guard data.count <= RequestLimits.maximumEncodedSize else { throw .tooLarge }
        do {
            return try JSONDecoder().decode(IdentifyRejectControlRequest.self, from: data)
        } catch let DecodingError.keyNotFound(key, _) {
            throw .malformed("missing \(key.stringValue)")
        } catch let DecodingError.typeMismatch(_, context) {
            throw .malformed("wrong type at \(context.codingPath.map(\.stringValue).joined(separator: "."))")
        } catch {
            throw .malformed("undecodable")
        }
    }
}

/// Decodes a JSON object of string values, silently dropping entries whose
/// value is not a string (numbers, `null`, nested objects). `attrs` are
/// optional hints, so a sloppy attribute should not fail the whole request.
struct LossyStringMap: Decodable {
    var values: [String: String]

    private struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        var values: [String: String] = [:]
        for key in c.allKeys {
            if let value = try? c.decode(String.self, forKey: key) {
                values[key.stringValue] = value
            }
        }
        self.values = values
    }
}

// MARK: - Result (native → extension)

/// `{ "type": "identifyRejectControlResult", "version": 1, … }`
///
/// Invariant (enforced by the initialiser): `candidateId` is non-nil if and
/// only if `status == .ok`. A `.ok` without a candidate is downgraded to
/// `.error`, and any other status drops the candidate.
public struct IdentifyRejectControlResult: Codable, Sendable, Equatable {
    public static let messageType = "identifyRejectControlResult"

    public enum Status: String, Codable, Sendable, CaseIterable {
        /// The only status on which the content script may click.
        case ok
        case none
        case notConsent = "not-consent"
        case uncertain
        case unavailable
        case error
    }

    public enum Confidence: String, Codable, Sendable, CaseIterable {
        case high, medium, low
    }

    public enum Engine: String, Codable, Sendable {
        case foundationModels = "foundation-models"
        case none
    }

    public let type: String
    public let version: Int
    public let status: Status
    public let candidateId: String?
    public let confidence: Confidence?
    public let reason: String
    public let engine: Engine

    public init(status: Status, candidateId: String? = nil, confidence: Confidence? = nil, reason: String, engine: Engine) {
        self.type = Self.messageType
        self.version = IdentifyRejectControlRequest.supportedVersion
        if status == .ok, let candidateId, !candidateId.isEmpty {
            self.status = .ok
            self.candidateId = candidateId
            self.reason = reason
        } else if status == .ok {
            self.status = .error
            self.candidateId = nil
            self.reason = "internal: ok without candidate"
        } else {
            self.status = status
            self.candidateId = nil
            self.reason = reason
        }
        self.confidence = confidence
        self.engine = engine
    }

    public static func error(_ reason: String, engine: Engine = .none) -> Self {
        Self(status: .error, reason: reason, engine: engine)
    }

    private enum CodingKeys: String, CodingKey {
        case type, version, status, candidateId, confidence, reason, engine
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            status: try c.decode(Status.self, forKey: .status),
            candidateId: try c.decodeIfPresent(String.self, forKey: .candidateId),
            confidence: try c.decodeIfPresent(Confidence.self, forKey: .confidence),
            reason: try c.decode(String.self, forKey: .reason),
            engine: try c.decode(Engine.self, forKey: .engine)
        )
    }

    /// Encodes `candidateId` and `confidence` as explicit `null` when absent,
    /// matching the contract (`"candidateId": "c2" | null`).
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        try c.encode(version, forKey: .version)
        try c.encode(status, forKey: .status)
        try c.encode(candidateId, forKey: .candidateId)
        try c.encode(confidence, forKey: .confidence)
        try c.encode(reason, forKey: .reason)
        try c.encode(engine, forKey: .engine)
    }

    /// The `[String: Any]` form to place under `SFExtensionMessageKey`.
    /// Absent values become `NSNull`, which Safari hands to JavaScript as `null`.
    public var dictionary: [String: Any] {
        if let data = try? JSONEncoder().encode(self),
           let object = try? JSONSerialization.jsonObject(with: data, options: []),
           let dictionary = object as? [String: Any] {
            return dictionary
        }
        // Unreachable in practice; still never return something clickable.
        return [
            "type": Self.messageType,
            "version": IdentifyRejectControlRequest.supportedVersion,
            "status": Status.error.rawValue,
            "candidateId": NSNull(),
            "confidence": NSNull(),
            "reason": "internal: encoding failed",
            "engine": Engine.none.rawValue,
        ]
    }
}
