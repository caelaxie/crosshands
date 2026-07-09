import CrossHandsComputerUseMacOSCore
import XCTest

final class SecureFieldMinimizationTests: XCTestCase {
    func testSecureValuesAreRedactedBeforeRendering() {
        XCTAssertEqual(
            SecureFieldMinimization.value("hunter2", isSecure: true),
            SecureFieldMinimization.redactedValue
        )
        XCTAssertFalse(SecureFieldMinimization.value("hunter2", isSecure: true)!.contains("hunter2"))
    }

    func testOrdinaryValuesArePreserved() {
        XCTAssertEqual(SecureFieldMinimization.value("hello", isSecure: false), "hello")
    }
}
