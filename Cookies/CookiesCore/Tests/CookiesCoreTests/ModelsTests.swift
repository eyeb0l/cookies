import XCTest
@testable import CookiesCore

final class ModelsTests: XCTestCase {
    func testDecodesSampleMessage() throws {
        let request = try IdentifyRejectControlRequest.decode(from: Fixtures.sampleMessage())
        XCTAssertEqual(request.type, "identifyRejectControl")
        XCTAssertEqual(request.version, 1)
        XCTAssertEqual(request.page, PageInfo(host: "example.com", lang: "en", frame: "top"))
        XCTAssertEqual(request.container?.role, "dialog")
        XCTAssertEqual(request.container?.attrs, ["id": "cookie-banner", "class": "cb-root"])
        XCTAssertEqual(request.candidates.map(\.id), ["c1", "c2", "c3"])
        XCTAssertEqual(request.candidates[1].text, "Reject all")
        XCTAssertEqual(request.candidates[1].disabled, false)
        XCTAssertEqual(request.candidates[2].attrs, ["href": "#"])
    }

    func testDecodingDropsNonStringAttributes() throws {
        var message = Fixtures.sampleMessage()
        message["candidates"] = [["id": "c1", "text": "Reject", "attrs": ["class": "x", "data-n": 3, "data-null": NSNull()]]]
        let request = try IdentifyRejectControlRequest.decode(from: message)
        XCTAssertEqual(request.candidates[0].attrs, ["class": "x"])
    }

    func testDecodingFailsOnMissingCandidates() {
        var message = Fixtures.sampleMessage()
        message["candidates"] = nil
        XCTAssertThrowsError(try IdentifyRejectControlRequest.decode(from: message)) { error in
            XCTAssertEqual(error as? RequestValidationError, .malformed("missing candidates"))
        }
    }

    func testDecodingFailsOnWrongTypes() {
        var message = Fixtures.sampleMessage()
        message["candidates"] = [["id": 1, "text": "Reject"]]
        XCTAssertThrowsError(try IdentifyRejectControlRequest.decode(from: message))
    }

    func testRefusesOversizedMessage() {
        var message = Fixtures.sampleMessage()
        message["container"] = ["text": String(repeating: "a", count: RequestLimits.maximumEncodedSize)]
        XCTAssertThrowsError(try IdentifyRejectControlRequest.decode(from: message)) { error in
            XCTAssertEqual(error as? RequestValidationError, .tooLarge)
        }
    }

    func testOkResultEncodesToWireDictionary() {
        let result = IdentifyRejectControlResult(status: .ok, candidateId: "c2", confidence: .high, reason: "Reject all", engine: .foundationModels)
        let dictionary = result.dictionary
        XCTAssertEqual(dictionary["type"] as? String, "identifyRejectControlResult")
        XCTAssertEqual(dictionary["version"] as? Int, 1)
        XCTAssertEqual(dictionary["status"] as? String, "ok")
        XCTAssertEqual(dictionary["candidateId"] as? String, "c2")
        XCTAssertEqual(dictionary["confidence"] as? String, "high")
        XCTAssertEqual(dictionary["engine"] as? String, "foundation-models")
    }

    func testNonOkResultEncodesExplicitNulls() {
        let dictionary = IdentifyRejectControlResult(status: .notConsent, reason: "x", engine: .foundationModels).dictionary
        XCTAssertEqual(dictionary["status"] as? String, "not-consent")
        XCTAssertTrue(dictionary["candidateId"] is NSNull)
        XCTAssertTrue(dictionary["confidence"] is NSNull)
        XCTAssertEqual(Set(dictionary.keys), ["type", "version", "status", "candidateId", "confidence", "reason", "engine"])
    }

    func testCandidateIdOnlyAccompaniesOk() {
        let uncertain = IdentifyRejectControlResult(status: .uncertain, candidateId: "c2", reason: "x", engine: .foundationModels)
        XCTAssertNil(uncertain.candidateId)
        let okWithoutId = IdentifyRejectControlResult(status: .ok, candidateId: nil, reason: "x", engine: .foundationModels)
        XCTAssertEqual(okWithoutId.status, .error)
    }

    func testStatusWireValues() {
        XCTAssertEqual(IdentifyRejectControlResult.Status.allCases.map(\.rawValue),
                       ["ok", "none", "not-consent", "uncertain", "unavailable", "error"])
    }

    func testResultRoundTrips() throws {
        let result = IdentifyRejectControlResult(status: .uncertain, confidence: .medium, reason: "r", engine: .foundationModels)
        let data = try JSONEncoder().encode(result)
        XCTAssertEqual(try JSONDecoder().decode(IdentifyRejectControlResult.self, from: data), result)
    }

    func testAvailabilityDictionary() {
        let dictionary = ModelAvailabilityStatus(reason: .appleIntelligenceNotEnabled).dictionary
        XCTAssertEqual(dictionary["type"] as? String, "availability")
        XCTAssertEqual(dictionary["available"] as? Bool, false)
        XCTAssertEqual(dictionary["reason"] as? String, "apple-intelligence-not-enabled")
        XCTAssertEqual(dictionary["osSupported"] as? Bool, true)
        XCTAssertEqual(ModelAvailabilityStatus(reason: .osUnsupported).osSupported, false)
    }
}
