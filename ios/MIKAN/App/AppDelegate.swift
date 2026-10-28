import UIKit
import UserNotifications

/// UIKit glue for push notifications: owns the app state, passes the APNs token on, shows notifications in the
/// foreground as banners and opens the right screen on a tap.
final class AppDelegate: NSObject, UIApplicationDelegate {
    let appState = AppState.live()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        appState.push.didRegister(deviceToken: deviceToken)
        Task { await appState.registerPushDevice() }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        appState.push.didFailToRegister(error)
    }
}

// Nonisolated: iOS may call these off the main thread; the app state is reached by hopping to the main actor.
extension AppDelegate: nonisolated UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        await MainActor.run { appState.foregroundPresentation() }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let route = PushRoute(userInfo: response.notification.request.content.userInfo)
        Task { @MainActor in
            guard self.appState.phase == .signedIn else { return }
            self.appState.open(route)
            await self.appState.refreshBadges()
        }
        completionHandler()
    }
}
