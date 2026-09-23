import Darwin
import XCTest
@testable import CrossHandsComputerUseMacOSCore

final class ProcessStartIdentityTests: XCTestCase {
    func testKernelStartForThisProcessIsInThePast() throws {
        let started = try XCTUnwrap(kernelProcessStartDate(pid: getpid()))
        XCTAssertLessThanOrEqual(started.timeIntervalSince1970, Date().timeIntervalSince1970 + 2)
        XCTAssertGreaterThan(started.timeIntervalSince1970, 1_600_000_000)
    }

    func testKernelStartForADeadPidIsNil() {
        XCTAssertNil(kernelProcessStartDate(pid: 0))
        XCTAssertNil(kernelProcessStartDate(pid: pid_t.max))
    }
}
