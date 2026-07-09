public enum SecureFieldMinimization {
    public static let redactedValue = "[redacted]"

    public static func value(_ value: String?, isSecure: Bool) -> String? {
        isSecure ? redactedValue : value
    }
}
