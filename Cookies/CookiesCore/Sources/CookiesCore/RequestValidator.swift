//
//  RequestValidator.swift
//  CookiesCore
//
//  Structural validation and normalisation of an `identifyRejectControl`
//  request before anything reaches the model.
//

import Foundation

/// Hard limits from docs/ARCHITECTURE.md. Lengths count Swift `Character`s
/// (grapheme clusters) after sanitising.
public enum RequestLimits {
    public static let maximumCandidates = 12
    public static let candidateTextLength = 80
    public static let candidateAriaLength = 80
    public static let attributeValueLength = 60
    public static let attributeKeyLength = 40
    public static let maximumAttributes = 6
    public static let containerTextLength = 600
    public static let tagLength = 24
    public static let roleLength = 40
    public static let hostLength = 253
    public static let langLength = 35
    public static let frameLength = 16
    /// Upper bound on the JSON form of the whole message. A conforming
    /// request is a few KiB; anything far beyond that is refused unread.
    public static let maximumEncodedSize = 64 * 1024
}

/// Why a request was refused. Every case maps to `status: "error"`.
public enum RequestValidationError: Error, Equatable, Sendable {
    case malformed(String)
    case tooLarge
    case wrongType(String)
    case unsupportedVersion(Int)
    case noCandidates
    case tooManyCandidates(Int)
    case invalidCandidateId
    case duplicateCandidateId

    /// Terse, page-text-free reason for the reply.
    public var reason: String {
        switch self {
        case .malformed(let detail): "invalid-request: \(detail)"
        case .tooLarge: "invalid-request: too large"
        case .wrongType: "invalid-request: unexpected type"
        case .unsupportedVersion(let v): "invalid-request: unsupported version \(v)"
        case .noCandidates: "invalid-request: no candidates"
        case .tooManyCandidates(let n): "invalid-request: \(n) candidates (max \(RequestLimits.maximumCandidates))"
        case .invalidCandidateId: "invalid-request: bad candidate id"
        case .duplicateCandidateId: "invalid-request: duplicate candidate id"
        }
    }
}

public enum RequestValidator {
    /// Decodes and validates a raw `SFExtensionMessageKey` dictionary.
    public static func validate(message: [String: Any]) throws(RequestValidationError) -> IdentifyRejectControlRequest {
        try validate(try IdentifyRejectControlRequest.decode(from: message))
    }

    /// Validates structure and returns a normalised copy.
    ///
    /// Structural problems (wrong type/version, candidate count, ids) are
    /// errors. Content problems (overlong strings, control characters) are
    /// normalised: strings are sanitised and truncated to the contract's caps,
    /// attributes are reduced to at most `maximumAttributes` entries in a
    /// deterministic order.
    public static func validate(_ request: IdentifyRejectControlRequest) throws(RequestValidationError) -> IdentifyRejectControlRequest {
        guard request.type == IdentifyRejectControlRequest.messageType else { throw .wrongType(request.type) }
        guard request.version == IdentifyRejectControlRequest.supportedVersion else { throw .unsupportedVersion(request.version) }
        guard !request.candidates.isEmpty else { throw .noCandidates }
        guard request.candidates.count <= RequestLimits.maximumCandidates else {
            throw .tooManyCandidates(request.candidates.count)
        }

        var seen = Set<String>()
        for candidate in request.candidates {
            guard isValidCandidateId(candidate.id) else { throw .invalidCandidateId }
            guard seen.insert(candidate.id).inserted else { throw .duplicateCandidateId }
        }

        let page = request.page.map {
            PageInfo(
                host: TextSanitiser.clean($0.host, limit: RequestLimits.hostLength),
                lang: TextSanitiser.clean($0.lang, limit: RequestLimits.langLength),
                frame: TextSanitiser.clean($0.frame, limit: RequestLimits.frameLength)
            )
        }
        let container = request.container.map {
            ContainerInfo(
                tag: TextSanitiser.clean($0.tag, limit: RequestLimits.tagLength),
                role: TextSanitiser.clean($0.role, limit: RequestLimits.roleLength),
                text: TextSanitiser.clean($0.text, limit: RequestLimits.containerTextLength),
                attrs: normaliseAttributes($0.attrs)
            )
        }
        let candidates = request.candidates.map {
            Candidate(
                id: $0.id,
                tag: TextSanitiser.clean($0.tag, limit: RequestLimits.tagLength),
                text: TextSanitiser.clean($0.text, limit: RequestLimits.candidateTextLength),
                aria: TextSanitiser.clean($0.aria, limit: RequestLimits.candidateAriaLength),
                attrs: normaliseAttributes($0.attrs),
                role: TextSanitiser.clean($0.role, limit: RequestLimits.roleLength),
                disabled: $0.disabled
            )
        }
        return IdentifyRejectControlRequest(
            type: request.type,
            version: request.version,
            page: page,
            container: container,
            candidates: candidates
        )
    }

    /// `^c\d{1,2}$`, ASCII digits only (so `"c١"` or `"c 1"` are rejected).
    public static func isValidCandidateId(_ id: String) -> Bool {
        let scalars = Array(id.unicodeScalars)
        guard (2...3).contains(scalars.count), scalars[0] == "c" else { return false }
        return scalars.dropFirst().allSatisfy { ("0"..."9").contains($0) }
    }

    /// Keeps `id`, `class`, `name` first, then everything else by key, capped
    /// at `maximumAttributes`. Empty keys/values are dropped.
    static func normaliseAttributes(_ attrs: [String: String]?) -> [String: String]? {
        guard let attrs, !attrs.isEmpty else { return nil }
        var result: [String: String] = [:]
        for key in orderedKeys(attrs.keys) {
            guard result.count < RequestLimits.maximumAttributes,
                  let cleanKey = TextSanitiser.clean(key, limit: RequestLimits.attributeKeyLength),
                  let value = attrs[key],
                  let cleanValue = TextSanitiser.clean(value, limit: RequestLimits.attributeValueLength)
            else { continue }
            result[cleanKey] = cleanValue
        }
        return result.isEmpty ? nil : result
    }

    /// Deterministic attribute order used by the validator and the prompt.
    static func orderedKeys(_ keys: some Sequence<String>) -> [String] {
        let preferred = ["id", "class", "name", "href"]
        return keys.sorted { a, b in
            let ia = preferred.firstIndex(of: a) ?? preferred.count
            let ib = preferred.firstIndex(of: b) ?? preferred.count
            return ia != ib ? ia < ib : a < b
        }
    }
}

/// String hygiene shared by the validator and the prompt renderer.
public enum TextSanitiser {
    /// Removes control (Cc) and format (Cf) characters, which includes
    /// zero-width spaces/joiners and bidi overrides that could otherwise be
    /// used to hide words from the lexicon (e.g. `"Ac\u{200B}cept"`). Line
    /// breaks and tabs become spaces; whitespace runs collapse; the result is
    /// trimmed and truncated to `limit` characters. Returns `nil` when empty.
    public static func clean(_ string: String?, limit: Int) -> String? {
        guard let string else { return nil }
        var scalars = String.UnicodeScalarView()
        var lastWasSpace = true
        for scalar in string.unicodeScalars {
            let category = scalar.properties.generalCategory
            if scalar.properties.isWhitespace || category == .lineSeparator || category == .paragraphSeparator
                || scalar == "\n" || scalar == "\r" || scalar == "\t" {
                if !lastWasSpace { scalars.append(" ") }
                lastWasSpace = true
                continue
            }
            if category == .control || category == .format || category == .surrogate || category == .privateUse
                || category == .unassigned {
                continue
            }
            scalars.append(scalar)
            lastWasSpace = false
        }
        var result = String(scalars)
        while result.last == " " { result.removeLast() }
        guard !result.isEmpty else { return nil }
        return truncate(result, to: limit)
    }

    /// Truncates to `limit` grapheme clusters, appending "…" when shortened.
    public static func truncate(_ string: String, to limit: Int) -> String {
        guard limit > 0 else { return "" }
        guard string.count > limit else { return string }
        var head = String(string.prefix(max(limit - 1, 0)))
        while head.last == " " { head.removeLast() }
        return head + "…"
    }
}
