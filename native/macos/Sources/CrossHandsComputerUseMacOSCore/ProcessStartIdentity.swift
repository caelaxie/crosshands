import Darwin
import Foundation

/// Launch Services can omit `NSRunningApplication.launchDate` for a live app.
/// The kernel start time stays constant for the life of that pid.
public func kernelProcessStartDate(pid: pid_t) -> Date? {
    guard pid > 0 else { return nil }
    var info = proc_bsdinfo()
    let expected = Int32(MemoryLayout<proc_bsdinfo>.stride)
    let size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, expected)
    guard size == expected else { return nil }
    let seconds = TimeInterval(info.pbi_start_tvsec)
    guard seconds > 0 else { return nil }
    let micros = TimeInterval(info.pbi_start_tvusec) / 1_000_000
    return Date(timeIntervalSince1970: seconds + micros)
}
