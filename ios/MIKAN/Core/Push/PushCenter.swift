import Foundation
import Observation
import os
import UIKit
import UserNotifications

/// Staff push notifications: permission, the APNs device token and its registration with the server
/// (docs/API.md «Push notifications»). The app delegate hands it the token; `AppState` drives the rest.
@Observable
final class PushCenter {
    /// The APNs device token (hex) once iOS gave one.
    private(set) var deviceToken: String?
    /// The device token and the session it was last sent for, so a session sends it once.
    @ObservationIgnored private var registeredKey: String?
    /// A `POST /devices` is in flight (the key is set only once it succeeds).
    @ObservationIgnored private var isRegistering = false
    @ObservationIgnored private let environment: PushEnvironment
    @ObservationIgnored private let logger = Logger(subsystem: "com.mikanstudio.crm", category: "push")

    init(environment: PushEnvironment = .current) {
        self.environment = environment
    }

    /// Asks for permission (iOS shows the question only once) and, when allowed, registers with APNs: the token
    /// comes back through the app delegate. Repeated on every sign-in and launch, as Apple recommends.
    func requestAuthorization() async {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            guard granted else {
                logger.notice("Notifications are not allowed")
                return
            }
            UIApplication.shared.registerForRemoteNotifications()
        } catch {
            logger.error("Notification permission failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func didRegister(deviceToken data: Data) {
        let token = Self.hex(data)
        guard Self.isValidToken(token) else {
            logger.error("APNs gave an unexpected token of \(data.count) bytes")
            return
        }
        deviceToken = token
    }

    func didFailToRegister(_ error: any Error) {
        logger.error("APNs registration failed: \(error.localizedDescription, privacy: .public)")
    }

    /// `POST /devices` for the signed-in employee: once per token and session, retried by the badge poll after a
    /// failure.
    func register(with api: APIClient) async {
        guard !isRegistering, let deviceToken, let session = api.token else { return }
        let key = Self.registrationKey(deviceToken: deviceToken, session: session)
        guard key != registeredKey else { return }
        isRegistering = true
        defer { isRegistering = false }
        do {
            try await api.registerDevice(DeviceBody(token: deviceToken, environment: environment))
            registeredKey = key
        } catch is CancellationError {
            return
        } catch {
            logger.notice("Device registration failed: \(error.userMessage, privacy: .public)")
        }
    }

    /// Signing out: forgets this session's registration and clears the employee's notifications already shown on
    /// this iPhone. Returns the device token to remove from the server (`DELETE /devices/:token`, sent with the
    /// ending session — see `AppState.endServerSession`).
    func endRegistration() -> String? {
        registeredKey = nil
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        return deviceToken
    }

    /// APNs hands the token as bytes; the server keeps it as lowercase hex.
    nonisolated static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    /// What `POST /devices` accepts: hex, 32–100 digits (an APNs token is 32 bytes, 64 digits).
    nonisolated static func isValidToken(_ token: String) -> Bool {
        tokenLength.contains(token.count) && token.allSatisfy(\.isHexDigit)
    }

    nonisolated private static let tokenLength = 32...100

    private static func registrationKey(deviceToken: String, session: String) -> String {
        "\(deviceToken)|\(session)"
    }
}
