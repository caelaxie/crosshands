import Foundation
import XCTest

final class CrossHandsBrandingTests: XCTestCase {
    func testPackageAndProviderUseStableCrossHandsIdentity() throws {
        let root = packageRoot()
        let manifest = try String(contentsOf: root.appendingPathComponent("Package.swift"), encoding: .utf8)
        let entrypoint = try String(
            contentsOf: root.appendingPathComponent("Sources/CrossHandsComputerUseMacOS/main.swift"),
            encoding: .utf8
        )
        let plist = try String(contentsOf: root.appendingPathComponent("App/Info.plist"), encoding: .utf8)

        XCTAssertTrue(manifest.contains("CrossHandsComputerUseMacOS"))
        XCTAssertTrue(manifest.contains("crosshands-computer-use-macos"))
        XCTAssertTrue(entrypoint.contains("ai.crosshands.ComputerUse"))
        XCTAssertTrue(entrypoint.contains("CrossHands Computer Use"))
        XCTAssertFalse(entrypoint.contains("Orca Computer Use"))
        XCTAssertTrue(plist.contains("ai.crosshands.ComputerUse"))
        XCTAssertTrue(plist.contains("CrossHands Computer Use"))
    }

    private func packageRoot(file: StaticString = #filePath) -> URL {
        URL(fileURLWithPath: "\(file)")
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }
}
