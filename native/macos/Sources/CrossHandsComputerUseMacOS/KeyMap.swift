import CoreGraphics
import Foundation

struct KeyModifier {
    let keyCode: CGKeyCode
    let flag: CGEventFlags
}

struct ParsedKey {
    let keyCode: CGKeyCode
    let modifiers: [KeyModifier]
}

enum KeyMap {
    static func parseModifier(_ spec: String) throws -> KeyModifier {
        guard let modifier = modifier(for: spec) else {
            throw ProviderError.coded("invalid_argument", "unsupported modifier '\(spec)'")
        }
        return modifier
    }

    static func modifier(for spec: String) -> KeyModifier? {
        switch spec.lowercased() {
        case "cmd", "command", "meta", "super", "cmdorctrl", "commandorcontrol":
            return KeyModifier(keyCode: 55, flag: .maskCommand)
        case "ctrl", "control":
            return KeyModifier(keyCode: 59, flag: .maskControl)
        case "alt", "option":
            return KeyModifier(keyCode: 58, flag: .maskAlternate)
        case "shift":
            return KeyModifier(keyCode: 56, flag: .maskShift)
        default:
            return nil
        }
    }

    static func parse(_ spec: String) throws -> ParsedKey {
        let parts = spec.split(separator: "+").map { String($0).lowercased() }
        var modifiers: [KeyModifier] = []
        var keyName: String?
        for part in parts {
            if let modifier = modifier(for: part) {
                modifiers.append(modifier)
            } else {
                keyName = part
            }
        }
        guard let keyName, let keyCode = codes[keyName] else {
            throw ProviderError.coded("invalid_argument", "unsupported key '\(spec)'")
        }
        return ParsedKey(keyCode: keyCode, modifiers: modifiers)
    }

    private static let codes: [String: CGKeyCode] = [
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
