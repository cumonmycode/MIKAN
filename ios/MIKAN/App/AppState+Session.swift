import Foundation
import os

// MARK: - Signing out on the server (docs/API.md «Sessions», «Push notifications»)

extension AppState {
    /// Called by `signOut` before the token is cleared: this iPhone's push token is removed first (that needs the
    /// session), then the session itself ends (`POST /auth/logout`). Best effort and in the background — the app
    /// signs out locally either way; sent by its own client, so a refused (already ended) session signs no one out
    /// again.
    func endServerSession() {
        let deviceToken = push.endRegistration()
        guard let token = api.token else { return }
        let client = APIClient(serverURL: api.serverURL, token: token, session: .shared)
        Task {
            await Self.endRemotely(client: client, deviceToken: deviceToken)
        }
    }

    private static func endRemotely(client: APIClient, deviceToken: String?) async {
        let logger = Logger(subsystem: "com.mikanstudio.crm", category: "session")
        if let deviceToken {
            do {
                try await client.unregisterDevice(token: deviceToken)
            } catch {
                logger.notice("Device removal failed: \(error.userMessage, privacy: .public)")
            }
        }
        do {
            try await client.logout()
        } catch {
            logger.notice("Sign-out on the server failed: \(error.userMessage, privacy: .public)")
        }
    }
}
