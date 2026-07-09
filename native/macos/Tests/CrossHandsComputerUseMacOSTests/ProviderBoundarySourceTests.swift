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
        XCTAssertTrue(source.contains("SO_NOSIGPIPE"))
        XCTAssertTrue(source.contains("request.token != expectedToken"))
        XCTAssertFalse(source.contains("computer-sidecar.js"))
    }

    func testWindowEnumerationAndUnicodeInputPreserveContractSemantics() throws {
        let source = try entrypoint()
        XCTAssertTrue(source.contains("CGWindowListCopyWindowInfo([.optionAll]"))
        XCTAssertTrue(source.contains("for character in text"))
        XCTAssertTrue(source.contains("stringLength: buffer.count"))
        XCTAssertFalse(source.contains("for unit in text.utf16"))
        XCTAssertTrue(source.contains("down.postToPid(pid)"))
        XCTAssertTrue(source.contains("event.postToPid(pid)"))
        XCTAssertFalse(source.contains("post(tap: .cghidEventTap)"))
    }

    func testHandshakeUsesCrossHandsVersionDomainsAndNoOrcaContextNames() throws {
        let source = try entrypoint()
        for field in ["providerProtocol", "publicContract", "graphicalSessionId", "generation"] {
            XCTAssertTrue(source.contains("\"\(field)\""), "missing \(field)")
        }
        XCTAssertFalse(source.contains("params[\"session\"]"))
        XCTAssertFalse(source.contains("params[\"worktree\"]"))
    }

    func testVerificationMetadataNeverSerializesLiteralInput() throws {
        let source = try entrypoint()
        XCTAssertFalse(source.contains("\"expected\": jsonNullable"))
        XCTAssertFalse(source.contains("\"actualPreview\": jsonNullable"))
    }

    func testNativeDispatchRechecksProcessIdentity() throws {
        let source = try entrypoint()
        XCTAssertTrue(source.contains("expectedProcessStartedAt"))
        XCTAssertTrue(source.contains("expectedExecutableId"))
        XCTAssertTrue(source.contains("target process changed before dispatch"))
    }

    func testScreenshotLimiterNeverReturnsOversizedFallback() throws {
        let source = try entrypoint()
        let start = try XCTUnwrap(source.range(of: "private func boundedPngData"))
        let end = try XCTUnwrap(source.range(of: "private func resizePng", range: start.upperBound..<source.endIndex))
        let limiter = String(source[start.lowerBound..<end.lowerBound])
        XCTAssertTrue(limiter.contains("while scale >= 0.25"))
        XCTAssertTrue(limiter.contains("return nil"))
        XCTAssertFalse(limiter.contains("return best"))
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
