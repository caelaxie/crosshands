import Foundation
import XCTest

final class ReleaseSigningSourceTests: XCTestCase {
    func testReleaseCodesignEnablesHardenedRuntimeAndSecureTimestamp() throws {
        let script = try String(contentsOf: packageRoot().appendingPathComponent("scripts/build-universal-app.sh"), encoding: .utf8)

        XCTAssertTrue(script.contains("IDENTITY=${CROSSHANDS_CODESIGN_IDENTITY:--}"))
        XCTAssertTrue(script.contains("--options runtime"))
        XCTAssertTrue(script.contains("--timestamp"))
    }

    private func packageRoot(file: StaticString = #filePath) -> URL {
        URL(fileURLWithPath: "\(file)")
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }
}
