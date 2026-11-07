import XCTest
@testable import CookiesCore

final class RequestValidatorTests: XCTestCase {
    private func validate(_ request: IdentifyRejectControlRequest) -> Result<IdentifyRejectControlRequest, RequestValidationError> {
        Result { () throws(RequestValidationError) in try RequestValidator.validate(request) }
    }

    func testAcceptsSample() throws {
        let request = try Fixtures.sampleRequest()
        XCTAssertEqual(request.candidates.count, 3)
        // Empty aria/role strings normalise to nil.
        XCTAssertNil(request.candidates[0].aria)
        XCTAssertNil(request.candidates[0].role)
    }

    func testRejectsWrongVersion() {
        var request = Fixtures.request(candidates: Fixtures.candidates("Reject"))
        request.version = 2
        XCTAssertEqual(validate(request).error, .unsupportedVersion(2))
    }

    func testRejectsWrongType() {
        var request = Fixtures.request(candidates: Fixtures.candidates("Reject"))
        request.type = "classify"
        XCTAssertEqual(validate(request).error, .wrongType("classify"))
    }

    func testRejectsNoCandidates() {
        XCTAssertEqual(validate(Fixtures.request(candidates: [])).error, .noCandidates)
    }

    func testAcceptsTwelveRejectsThirteenCandidates() {
        let twelve = (1...12).map { Candidate(id: "c\($0)", text: "b\($0)") }
        XCTAssertNil(validate(Fixtures.request(candidates: twelve)).error)
        let thirteen = (1...13).map { Candidate(id: "c\($0)", text: "b\($0)") }
        XCTAssertEqual(validate(Fixtures.request(candidates: thirteen)).error, .tooManyCandidates(13))
    }

    func testRejectsBadIds() {
        for id in ["", "c", "C1", "c123", "x1", "c-1", "c1 ", " c1", "c١", "none", "c1\u{0}", "cc1"] {
            let request = Fixtures.request(candidates: [Candidate(id: id, text: "Reject")])
            XCTAssertEqual(validate(request).error, .invalidCandidateId, "id \(id.debugDescription)")
        }
        for id in ["c0", "c1", "c9", "c12", "c99"] {
            XCTAssertTrue(RequestValidator.isValidCandidateId(id), id)
        }
    }

    func testRejectsDuplicateIds() {
        let request = Fixtures.request(candidates: [Candidate(id: "c1", text: "A"), Candidate(id: "c1", text: "B")])
        XCTAssertEqual(validate(request).error, .duplicateCandidateId)
    }

    func testTruncatesAndStripsControlCharacters() throws {
        let long = String(repeating: "x", count: 200)
        let request = Fixtures.request(
            candidates: [Candidate(id: "c1", text: "Re\u{200B}ject\u{0007}\n all\u{202E}", aria: long)],
            containerText: String(repeating: "y", count: 1_000)
        )
        let validated = try RequestValidator.validate(request)
        XCTAssertEqual(validated.candidates[0].text, "Reject all")
        XCTAssertEqual(validated.candidates[0].aria?.count, RequestLimits.candidateAriaLength)
        XCTAssertEqual(validated.candidates[0].aria?.last, "…")
        XCTAssertEqual(validated.container?.text?.count, RequestLimits.containerTextLength)
    }

    func testCapsAttributesDeterministically() throws {
        var attrs: [String: String] = [:]
        for i in 0..<10 { attrs["data-k\(i)"] = "v\(i)" }
        attrs["class"] = "btn"
        attrs["id"] = "reject"
        let validated = try RequestValidator.validate(Fixtures.request(candidates: [Candidate(id: "c1", text: "Reject", attrs: attrs)]))
        let kept = validated.candidates[0].attrs ?? [:]
        XCTAssertEqual(kept.count, RequestLimits.maximumAttributes)
        XCTAssertEqual(kept["id"], "reject")
        XCTAssertEqual(kept["class"], "btn")
        XCTAssertEqual(Set(kept.keys), ["id", "class", "data-k0", "data-k1", "data-k2", "data-k3"])
    }

    func testValidateMessageMapsDecodingErrors() {
        XCTAssertThrowsError(try RequestValidator.validate(message: ["type": "identifyRejectControl"]))
    }
}

extension Result {
    var error: Failure? {
        if case .failure(let error) = self { return error }
        return nil
    }
}
