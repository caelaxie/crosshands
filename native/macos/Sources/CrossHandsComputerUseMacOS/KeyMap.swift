import CoreGraphics
import CrossHandsComputerUseMacOSCore
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
    static func parse(_ spec: String) throws -> ParsedKey {
        let chord: KeyChord
        do {
            chord = try KeyChordParser.parse(spec)
        } catch let error as KeyChordError {
            throw ProviderError.coded(error.code, error.message)
        }
        return ParsedKey(keyCode: CGKeyCode(chord.keyCode), modifiers: chord.modifiers.map(eventModifier))
    }

    static func parseModifier(_ spec: String) throws -> KeyModifier {
        guard let modifier = KeyChordParser.modifier(for: spec) else {
            throw ProviderError.coded("invalid_argument", "unsupported modifier '\(spec)'")
        }
        return eventModifier(modifier)
    }

    private static func eventModifier(_ modifier: KeyChord.Modifier) -> KeyModifier {
        let flag: CGEventFlags
        switch modifier {
        case .command:
            flag = .maskCommand
        case .shift:
            flag = .maskShift
        case .option:
            flag = .maskAlternate
        case .control:
            flag = .maskControl
        }
        return KeyModifier(keyCode: CGKeyCode(modifier.rawValue), flag: flag)
    }
}
