import XCTest
@testable import CookiesCore

final class CookiesServiceTests: XCTestCase {
    func testEndToEndOk() async {
        let engine = FakeEngine(decision: .answered(isCookieConsentBanner: true, rejectControlId: "c2", confidence: "high", reason: "Reject all."))
        let reply = await CookiesService(engine: engine).handle(message: Fixtures.sampleMessage())
        XCTAssertEqual(reply["type"] as? String, "identifyRejectControlResult")
        XCTAssertEqual(reply["status"] as? String, "ok")
        XCTAssertEqual(reply["candidateId"] as? String, "c2")
        XCTAssertEqual(reply["engine"] as? String, "foundation-models")
    }

    func testEndToEndPolicyVeto() async {
        let engine = FakeEngine(decision: .answered(isCookieConsentBanner: true, rejectControlId: "c1", confidence: "high", reason: "x"))
        let reply = await CookiesService(engine: engine).handle(message: Fixtures.sampleMessage())
        XCTAssertEqual(reply["status"] as? String, "uncertain")
        XCTAssertTrue(reply["candidateId"] is NSNull)
    }

    func testInvalidMessageIsError() async {
        var message = Fixtures.sampleMessage()
        message["version"] = 7
        let reply = await CookiesService(engine: FakeEngine(decision: .failed("unused"))).handle(message: message)
        XCTAssertEqual(reply["status"] as? String, "error")
        XCTAssertEqual(reply["engine"] as? String, "none")
        XCTAssertEqual(reply["reason"] as? String, "invalid-request: unsupported version 7")
    }

    func testGarbageMessageIsError() async {
        let reply = await CookiesService(engine: FakeEngine(decision: .failed("unused"))).handle(message: ["type": "identifyRejectControl", "candidates": "nope"])
        XCTAssertEqual(reply["status"] as? String, "error")
    }

    func testEngineThrowingIsError() async {
        let reply = await CookiesService(engine: ThrowingEngine()).handle(message: Fixtures.sampleMessage())
        XCTAssertEqual(reply["status"] as? String, "error")
        XCTAssertEqual(reply["reason"] as? String, "generation-failed")
        XCTAssertTrue(reply["candidateId"] is NSNull)
    }

    func testUnavailableEngine() async {
        let reply = await CookiesService(engine: FakeEngine(decision: .unavailable("device-not-eligible"))).handle(message: Fixtures.sampleMessage())
        XCTAssertEqual(reply["status"] as? String, "unavailable")
        XCTAssertEqual(reply["engine"] as? String, "none")
    }

    func testTimeoutWithCooperativeEngine() async {
        let engine = FakeEngine(decision: .answered(isCookieConsentBanner: true, rejectControlId: "c2", confidence: "high", reason: "late"), delay: .seconds(10))
        let start = ContinuousClock.now
        let reply = await CookiesService(engine: engine, timeout: .milliseconds(200)).handle(message: Fixtures.sampleMessage())
        XCTAssertEqual(reply["status"] as? String, "error")
        XCTAssertEqual(reply["reason"] as? String, "timeout")
        XCTAssertLessThan(ContinuousClock.now - start, .seconds(3))
    }

    func testTimeoutWithEngineIgnoringCancellation() async {
        let engine = FakeEngine(decision: .answered(isCookieConsentBanner: true, rejectControlId: "c2", confidence: "high", reason: "late"),
                                delay: .seconds(2), ignoresCancellation: true)
        let start = ContinuousClock.now
        let reply = await CookiesService(engine: engine, timeout: .milliseconds(200)).handle(message: Fixtures.sampleMessage())
        XCTAssertEqual(reply["reason"] as? String, "timeout")
        XCTAssertLessThan(ContinuousClock.now - start, .milliseconds(1_500))
    }

    func testFastEngineBeatsTimeout() async {
        let engine = FakeEngine(decision: .answered(isCookieConsentBanner: false, rejectControlId: "none", confidence: "high", reason: "x"), delay: .milliseconds(10))
        let reply = await CookiesService(engine: engine, timeout: .seconds(5)).handle(message: Fixtures.sampleMessage())
        XCTAssertEqual(reply["status"] as? String, "not-consent")
    }

    func testConcurrentRequestsAreIndependent() async {
        let service = CookiesService(engine: FakeEngine(decision: .answered(isCookieConsentBanner: true, rejectControlId: "c2", confidence: "high", reason: "r"), delay: .milliseconds(20)))
        let statuses = await withTaskGroup(of: String?.self) { group in
            for _ in 0..<16 {
                group.addTask { await service.handle(message: Fixtures.sampleMessage())["status"] as? String }
            }
            var all: [String?] = []
            for await status in group { all.append(status) }
            return all
        }
        XCTAssertEqual(statuses, Array(repeating: "ok", count: 16))
    }
}
