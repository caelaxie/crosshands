import Foundation
import XCTest

final class ProviderBoundarySourceTests: XCTestCase {
    func testScreenCaptureKitIsTheOnlyScreenshotEngine() throws {
        let source = try entrypoint()
        XCTAssertTrue(source.contains("SCScreenshotManager.captureImage"))
        XCTAssertFalse(source.contains("CGWindowListCreateImage"))
        XCTAssertFalse(source.contains("CROSSHANDS_COMPUTER_USE_SCK_SCREENSHOTS"))
    }

    func testPermissionChecksStaySeparateAndDoNotRequestTCCProgrammatically() throws {
        let source = try entrypoint()
        XCTAssertTrue(source.contains("AXIsProcessTrusted()"))
        XCTAssertTrue(source.contains("CGPreflightScreenCaptureAccess()"))
        XCTAssertFalse(source.contains("CGRequestScreenCaptureAccess()"))
    }

    func testSocketRequiresTokenAndSameUserPeer() throws {
        let source = try entrypoint()
        XCTAssertTrue(source.contains("getpeereid(fd"))
        XCTAssertTrue(source.contains("peerUser == geteuid()"))
        XCTAssertTrue(source.contains("request.token != expectedToken"))
        XCTAssertFalse(source.contains("computer-sidecar.js"))
    }

    func testHandshakeUsesCrossHandsVersionDomainsAndNoOrcaContextNames() throws {
        let source = try entrypoint()
        for field in ["providerProtocol", "publicContract", "graphicalSessionId", "generation"] {
            XCTAssertTrue(source.contains("\"\(field)\""), "missing \(field)")
        }
        XCTAssertFalse(source.contains("params[\"session\"]"))
        XCTAssertFalse(source.contains("params[\"worktree\"]"))
    }

    private func entrypoint(file: StaticString = #filePath) throws -> String {
        let root = URL(fileURLWithPath: "\(file)")
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(
            contentsOf: root.appendingPathComponent("Sources/CrossHandsComputerUseMacOS/main.swift"),
            encoding: .utf8
        )
    }
}
