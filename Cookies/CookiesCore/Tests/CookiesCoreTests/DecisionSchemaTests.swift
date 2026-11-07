import XCTest
@testable import CookiesCore
#if canImport(FoundationModels)
import FoundationModels
#endif

final class DecisionSchemaTests: XCTestCase {
    func testSchemaBuilds() throws {
        #if canImport(FoundationModels)
        guard #available(macOS 26.0, iOS 26.0, *) else { throw XCTSkip("FoundationModels needs macOS/iOS 26") }
        let schema = try DecisionSchema.make(candidateIds: ["c1", "c2", "c3"])
        let description = String(describing: schema)
        XCTAssertFalse(description.isEmpty)
        XCTAssertThrowsError(try DecisionSchema.make(candidateIds: []))
        #else
        throw XCTSkip("FoundationModels not in this SDK")
        #endif
    }

    func testAvailabilityIsReported() {
        let status = ModelAvailability.current()
        #if canImport(FoundationModels)
        if #available(macOS 26.0, iOS 26.0, *) {
            XCTAssertTrue(status.osSupported)
        } else {
            XCTAssertEqual(status.reason, .osUnsupported)
        }
        #else
        XCTAssertEqual(status.reason, .frameworkUnavailable)
        #endif
    }

    /// Opt-in: `COOKIES_LIVE_MODEL=1 swift test --filter testLiveModel`.
    /// Never required; asserts only that the live path fails closed.
    func testLiveModel() async throws {
        guard ProcessInfo.processInfo.environment["COOKIES_LIVE_MODEL"] == "1" else {
            throw XCTSkip("set COOKIES_LIVE_MODEL=1 to exercise the on-device model")
        }
        guard ModelAvailability.current().available else { throw XCTSkip("model unavailable") }
        let request = try Fixtures.sampleRequest()
        let decision = await FoundationModelsEngine().classify(request)
        let result = DecisionPolicy.evaluate(decision, for: request)
        print("live decision:", decision, "→", result.status.rawValue, result.candidateId ?? "nil")
        XCTAssertTrue(result.status != .ok || result.candidateId == "c2")
    }
}
