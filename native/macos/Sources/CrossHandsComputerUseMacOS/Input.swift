import AppKit
import CoreGraphics
import CrossHandsComputerUseMacOSCore
import Foundation

enum MouseButton {
    case left
    case right

    var cgButton: CGMouseButton {
        switch self {
        case .left:
            return .left
        case .right:
            return .right
        }
    }

    var downEvent: CGEventType {
        switch self {
        case .left:
            return .leftMouseDown
        case .right:
            return .rightMouseDown
        }
    }

    var upEvent: CGEventType {
        switch self {
        case .left:
            return .leftMouseUp
        case .right:
            return .rightMouseUp
        }
    }
}

func mouseButton(_ raw: String?) throws -> MouseButton {
    switch raw ?? "left" {
    case "left":
        return .left
    case "right":
        return .right
    case "middle":
        throw ProviderError.coded("invalid_argument", "middle-click is not yet supported")
    case let value:
        throw ProviderError.coded("invalid_argument", "unsupported mouse button '\(value)'")
    }
}

enum Input {
    static func click(pid: pid_t, at point: CGPoint, button: MouseButton, count: Int, modifiers: [KeyModifier] = []) throws {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ProviderError.coded("accessibility_error", "failed to create event source")
        }
        try withHeldModifiers(modifiers, pid: pid) { flags in
            for _ in 0..<max(count, 1) {
                try mouse(.mouseMoved, source: source, point: point, button: button.cgButton, pid: pid, flags: flags)
                try mouse(button.downEvent, source: source, point: point, button: button.cgButton, pid: pid, flags: flags)
                try mouse(button.upEvent, source: source, point: point, button: button.cgButton, pid: pid, flags: flags)
            }
        }
    }

    static func scroll(pid: pid_t, at point: CGPoint, direction: String, pages: Double) throws {
        guard let delta = boundedInteger(max(1, (12 * pages).rounded()), as: Int32.self) else {
            throw ProviderError.coded("invalid_argument", "pages is out of range")
        }
        let wheel1: Int32 = direction == "up" ? delta : direction == "down" ? -delta : 0
        let wheel2: Int32 = direction == "left" ? delta : direction == "right" ? -delta : 0
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: wheel1, wheel2: wheel2, wheel3: 0) else {
            throw ProviderError.coded("accessibility_error", "failed to create scroll event")
        }
        event.location = point
        event.postToPid(pid)
    }

    static func drag(pid: pid_t, from start: CGPoint, to end: CGPoint, durationMs: Double) throws {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ProviderError.coded("accessibility_error", "failed to create event source")
        }
        try mouse(.mouseMoved, source: source, point: start, button: .left, pid: pid)
        try mouse(.leftMouseDown, source: source, point: start, button: .left, pid: pid)
        for step in 1...10 {
            let progress = CGFloat(step) / 10
            try mouse(
                .leftMouseDragged,
                source: source,
                point: CGPoint(x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress),
                button: .left,
                pid: pid
            )
            Thread.sleep(forTimeInterval: durationMs / 10_000)
        }
        try mouse(.leftMouseUp, source: source, point: end, button: .left, pid: pid)
    }

    static func typeText(_ text: String, pid: pid_t) throws {
        for character in text {
            let units = Array(String(character).utf16)
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            else {
                throw ProviderError.coded("accessibility_error", "failed to create keyboard event")
            }
            units.withUnsafeBufferPointer { buffer in
                guard let baseAddress = buffer.baseAddress else { return }
                down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: baseAddress)
                up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: baseAddress)
            }
            down.postToPid(pid)
            up.postToPid(pid)
        }
    }

    static func pressKey(_ key: String, pid: pid_t) throws {
        let parsed = try KeyMap.parse(key)
        try withHeldModifiers(parsed.modifiers, pid: pid) { flags in
            try keyEvent(parsed.keyCode, down: true, flags: flags, pid: pid)
            try keyEvent(parsed.keyCode, down: false, flags: flags, pid: pid)
        }
    }

    static func pasteText(_ text: String, pid: pid_t) throws {
        let pasteboard = NSPasteboard.general
        let previousItems: [NSPasteboardItem] = pasteboard.pasteboardItems?.map { item in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) {
                    copy.setData(data, forType: type)
                }
            }
            return copy
        } ?? []
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        defer {
            pasteboard.clearContents()
            if !previousItems.isEmpty {
                pasteboard.writeObjects(previousItems)
            }
        }
        try pressKey("cmd+v", pid: pid)
    }

    static func withHeldModifiers(
        _ modifiers: [KeyModifier],
        pid: pid_t,
        _ body: (CGEventFlags) throws -> Void
    ) throws {
        var flags = CGEventFlags()
        var held: [KeyModifier] = []
        var actionError: Error?
        do {
            for modifier in modifiers {
                flags.insert(modifier.flag)
                try keyEvent(modifier.keyCode, down: true, flags: flags, pid: pid)
                held.append(modifier)
            }
            try body(flags)
        } catch {
            actionError = error
        }
        var remaining = flags
        var releaseError: Error?
        for modifier in held.reversed() {
            do {
                try keyEvent(modifier.keyCode, down: false, flags: remaining, pid: pid)
            } catch {
                if releaseError == nil {
                    releaseError = error
                }
            }
            remaining.remove(modifier.flag)
        }
        if let actionError {
            throw actionError
        }
        if let releaseError {
            throw releaseError
        }
    }

    private static func mouse(_ type: CGEventType, source: CGEventSource, point: CGPoint, button: CGMouseButton, pid: pid_t, flags: CGEventFlags = []) throws {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
            throw ProviderError.coded("accessibility_error", "failed to create mouse event")
        }
        event.flags = flags
        event.postToPid(pid)
    }

    private static func keyEvent(_ keyCode: CGKeyCode, down: Bool, flags: CGEventFlags, pid: pid_t) throws {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down) else {
            throw ProviderError.coded("accessibility_error", "failed to create key event")
        }
        event.flags = flags
        event.postToPid(pid)
    }
}
