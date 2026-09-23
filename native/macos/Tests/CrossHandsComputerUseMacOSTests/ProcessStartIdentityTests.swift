import Darwin
import Foundation
import XCTest
@testable import CrossHandsComputerUseMacOSCore

final class ProcessStartIdentityTests: XCTestCase {
    func testPrefersLaunchServicesDateWhenPresent() {
        let launch = Date(timeIntervalSince1970: 1_700_000_000)
        let kernel = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(processStartedAt(launchDate: launch, kernelStart: kernel), launch)
    }

    func testUsesKernelStartWhenLaunchServicesOmitsIt() {
        let kernel = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(processStartedAt(launchDate: nil, kernelStart: kernel), kernel)
    }

    func testReturnsNilWhenNeitherClockIsAvailable() {
        XCTAssertNil(processStartedAt(launchDate: nil, kernelStart: nil))
    }

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
