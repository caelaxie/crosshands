import Foundation

public struct KeyChord: Equatable, Sendable {
    public let keyCode: UInt16
    public let modifiers: [Modifier]

    public enum Modifier: UInt16, Equatable, Sendable {
        case command = 55
        case shift = 56
        case option = 58
        case control = 59
    }
}

public enum KeyChordError: Error, Equatable {
    case unsupportedKey(String)
    case unsupportedModifier(String)

    public var code: String { "invalid_argument" }

    public var message: String {
        switch self {
        case let .unsupportedKey(spec):
            return "unsupported key '\(spec)'"
        case let .unsupportedModifier(spec):
            return "unsupported modifier '\(spec)'"
        }
    }
}

public enum KeyChordParser {
    public static func modifier(for spec: String) -> KeyChord.Modifier? {
        switch spec.lowercased() {
        case "cmd", "command", "meta", "super", "cmdorctrl", "commandorcontrol":
            return .command
        case "ctrl", "control":
            return .control
        case "alt", "option":
            return .option
        case "shift":
            return .shift
        default:
            return nil
        }
    }

    public static func parse(_ spec: String) throws -> KeyChord {
        let parts = spec.split(separator: "+").map { String($0).lowercased() }
        var modifiers: [KeyChord.Modifier] = []
        var keyName: String?
        for part in parts {
            if let modifier = modifier(for: part) {
                modifiers.append(modifier)
            } else {
                keyName = part
            }
        }
        guard var keyName else {
            throw KeyChordError.unsupportedKey(spec)
        }
        if keyName == "*" || keyName == "multiply" {
            keyName = "8"
            if !modifiers.contains(.shift) {
                modifiers.append(.shift)
            }
        }
        guard let keyCode = codes[keyName] else {
            throw KeyChordError.unsupportedKey(spec)
        }
        return KeyChord(keyCode: keyCode, modifiers: modifiers)
    }

    private static let codes: [String: UInt16] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
        "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
        "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
        "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
        "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
        "backspace": 51, "delete": 51, "escape": 53, "esc": 53, "left": 123, "right": 124,
        "down": 125, "up": 126, "insert": 114, "home": 115, "pageup": 116, "page_up": 116,
        "forwarddelete": 117, "end": 119, "pagedown": 121, "page_down": 121,
    ]
}
