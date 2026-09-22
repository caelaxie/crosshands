import XCTest
@testable import CrossHandsComputerUseMacOSCore

final class KeyChordTests: XCTestCase {
    func testDigitNineIsTheNineKey() throws {
        let parsed = try KeyChordParser.parse("9")
        XCTAssertEqual(parsed, KeyChord(keyCode: 25, modifiers: []))
    }

    func testLetterXStaysTheLetterKey() throws {
        let parsed = try KeyChordParser.parse("x")
        XCTAssertEqual(parsed, KeyChord(keyCode: 7, modifiers: []))
    }

    func testStarAndMultiplyMatchShiftEight() throws {
        let shiftedEight = try KeyChordParser.parse("shift+8")
        XCTAssertEqual(try KeyChordParser.parse("*"), shiftedEight)
        XCTAssertEqual(try KeyChordParser.parse("multiply"), shiftedEight)
        XCTAssertEqual(try KeyChordParser.parse("shift+*"), shiftedEight)
        XCTAssertEqual(shiftedEight, KeyChord(keyCode: 28, modifiers: [.shift]))
    }
}
