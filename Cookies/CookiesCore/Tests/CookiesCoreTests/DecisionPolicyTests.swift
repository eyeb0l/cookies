import XCTest
@testable import CookiesCore

final class DecisionPolicyTests: XCTestCase {
    private func request() throws -> IdentifyRejectControlRequest { try Fixtures.sampleRequest() }

    private func answer(
        consent: Bool = true,
        id: String = "c2",
        confidence: String = "high",
        reason: String = "c2 is labelled Reject all."
    ) -> RawDecision {
        .answered(isCookieConsentBanner: consent, rejectControlId: id, confidence: confidence, reason: reason)
    }

    func testHappyPathIsOk() throws {
        let result = DecisionPolicy.evaluate(answer(), for: try request())
        XCTAssertEqual(result.status, .ok)
        XCTAssertEqual(result.candidateId, "c2")
        XCTAssertEqual(result.confidence, .high)
        XCTAssertEqual(result.engine, .foundationModels)
        XCTAssertEqual(result.reason, "c2 is labelled Reject all.")
    }

    func testNotConsent() throws {
        let result = DecisionPolicy.evaluate(answer(consent: false), for: try request())
        XCTAssertEqual(result.status, .notConsent)
        XCTAssertNil(result.candidateId)
    }

    func testNoneSentinel() throws {
        let result = DecisionPolicy.evaluate(answer(id: "none"), for: try request())
        XCTAssertEqual(result.status, .none)
        XCTAssertNil(result.candidateId)
    }

    func testUnknownId() throws {
        let result = DecisionPolicy.evaluate(answer(id: "c9"), for: try request())
        XCTAssertEqual(result.status, .uncertain)
        XCTAssertNil(result.candidateId)
    }

    func testMediumConfidence() throws {
        let result = DecisionPolicy.evaluate(answer(confidence: "medium"), for: try request())
        XCTAssertEqual(result.status, .uncertain)
        XCTAssertEqual(result.confidence, .medium)
        XCTAssertNil(result.candidateId)
    }

    func testLowAndGarbageConfidence() throws {
        XCTAssertEqual(DecisionPolicy.evaluate(answer(confidence: "low"), for: try request()).status, .uncertain)
        let garbage = DecisionPolicy.evaluate(answer(confidence: "HIGH"), for: try request())
        XCTAssertEqual(garbage.status, .uncertain)
        XCTAssertNil(garbage.confidence)
    }

    func testAcceptLikeTextIsRefused() throws {
        // The model (wrongly) picks "Accept all" with high confidence.
        let result = DecisionPolicy.evaluate(answer(id: "c1"), for: try request())
        XCTAssertEqual(result.status, .uncertain)
        XCTAssertEqual(result.reason, "chosen control looks like accept")
    }

    func testAcceptLikeAriaIsRefused() {
        let request = Fixtures.request(candidates: [Candidate(id: "c1", tag: "button", text: "Reject all", aria: "Accept all cookies")])
        XCTAssertEqual(DecisionPolicy.evaluate(answer(id: "c1"), for: request).status, .uncertain)
    }

    func testDangerousTextIsRefused() {
        let request = Fixtures.request(candidates: Fixtures.candidates("Accept all", "Refuser et s'abonner"))
        let result = DecisionPolicy.evaluate(answer(id: "c2"), for: request)
        XCTAssertEqual(result.status, .uncertain)
        XCTAssertEqual(result.reason, "chosen control looks dangerous")
    }

    func testSettingsLinkIsRefused() throws {
        let result = DecisionPolicy.evaluate(answer(id: "c3"), for: try request())
        XCTAssertEqual(result.status, .uncertain)
        XCTAssertEqual(result.reason, "chosen control does not look like reject")
    }

    func testDisabledIsRefused() {
        let request = Fixtures.request(candidates: [Candidate(id: "c1", tag: "button", text: "Reject all", disabled: true)])
        XCTAssertEqual(DecisionPolicy.evaluate(answer(id: "c1"), for: request).status, .uncertain)
    }

    func testUnlabelledIsRefused() {
        let request = Fixtures.request(candidates: [Candidate(id: "c1", tag: "button", text: "×")])
        XCTAssertEqual(DecisionPolicy.evaluate(answer(id: "c1"), for: request).status, .uncertain)
    }

    func testIconButtonWithRejectAriaIsOk() {
        let request = Fixtures.request(candidates: [Candidate(id: "c1", tag: "button", text: "×", aria: "Reject all cookies")])
        XCTAssertEqual(DecisionPolicy.evaluate(answer(id: "c1"), for: request).status, .ok)
    }

    func testNecessaryOnlyViaReason() {
        let request = Fixtures.request(candidates: Fixtures.candidates("Accept all", "Necessary cookies"))
        let explained = DecisionPolicy.evaluate(answer(id: "c2", reason: "c2 is the necessary-only option."), for: request)
        XCTAssertEqual(explained.status, .ok)
        let unexplained = DecisionPolicy.evaluate(answer(id: "c2", reason: "c2 looks right."), for: request)
        XCTAssertEqual(unexplained.status, .uncertain)
    }

    func testMultilingualOk() {
        let request = Fixtures.request(candidates: Fixtures.candidates("Alle akzeptieren", "Alle ablehnen", "Einstellungen"))
        XCTAssertEqual(DecisionPolicy.evaluate(answer(id: "c2"), for: request).status, .ok)
        XCTAssertEqual(DecisionPolicy.evaluate(answer(id: "c1"), for: request).status, .uncertain)
        XCTAssertEqual(DecisionPolicy.evaluate(answer(id: "c3"), for: request).status, .uncertain)
    }

    func testUnavailableAndFailedKinds() throws {
        let unavailable = DecisionPolicy.evaluate(.unavailable("apple-intelligence-not-enabled"), for: try request())
        XCTAssertEqual(unavailable.status, .unavailable)
        XCTAssertEqual(unavailable.engine, .none)
        XCTAssertEqual(unavailable.reason, "apple-intelligence-not-enabled")
        let failed = DecisionPolicy.evaluate(.failed("guardrail-violation"), for: try request())
        XCTAssertEqual(failed.status, .error)
        XCTAssertNil(failed.candidateId)
    }

    func testReasonIsSanitisedAndCapped() throws {
        let result = DecisionPolicy.evaluate(answer(reason: "Reject\n" + String(repeating: "x", count: 500)), for: try request())
        XCTAssertEqual(result.status, .ok)
        XCTAssertLessThanOrEqual(result.reason.count, DecisionPolicy.maximumReasonLength)
        XCTAssertFalse(result.reason.contains("\n"))
    }
}
