import Foundation
import LocalAuthentication
import os

/// Face ID / Touch ID with the iPhone passcode as the fallback (`deviceOwnerAuthentication`).
nonisolated enum DeviceAuthentication {
    enum Method: Equatable, Sendable {
        case faceID
        case touchID
        case opticID
        /// No biometrics set up: the passcode only.
        case passcode
        /// No passcode on the iPhone: nothing can lock the app.
        case unavailable

        var title: String {
            switch self {
            case .faceID: "Face ID"
            case .touchID: "Touch ID"
            case .opticID: "Optic ID"
            case .passcode, .unavailable: "Код-пароль"
            }
        }

        var systemImage: String {
            switch self {
            case .faceID: "faceid"
            case .touchID: "touchid"
            case .opticID: "opticid"
            case .passcode, .unavailable: "lock"
            }
        }
    }

    private static let logger = Logger(subsystem: "com.mikanstudio.crm", category: "lock")

    static func availableMethod() -> Method {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return .unavailable }
        switch context.biometryType {
        case .faceID: return .faceID
        case .touchID: return .touchID
        case .opticID: return .opticID
        default: return .passcode
        }
    }

    /// Asks for Face ID (or the passcode); `false` when cancelled or failed.
    static func authenticate(reason: String) async -> Bool {
        let context = LAContext()
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch {
            logger.notice("Unlock failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }
}
