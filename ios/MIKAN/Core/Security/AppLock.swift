import Observation
import SwiftUI

/// The Face ID lock (docs/API.md «Sessions»): on by default on this iPhone, switched in More → «Безопасность».
/// What it covers and when follows `AppLockRule`; the scene's phase drives it.
@Observable
final class AppLock {
    static let enabledKey = "appLock.enabled"
    private static let unlockReason = "Разблокировка MIKAN"

    private(set) var rule: AppLockRule
    /// Saved on this iPhone; on unless switched off.
    private(set) var isEnabled: Bool
    private(set) var method: DeviceAuthentication.Method
    private(set) var isAuthenticating = false
    /// Each lock asks once by itself; after a cancel the button asks again.
    @ObservationIgnored private var promptsAutomatically = true
    @ObservationIgnored private let defaults: UserDefaults

    /// `signedInAtLaunch`: the app starts with a saved session, so it starts locked (when the lock is on).
    init(signedInAtLaunch: Bool = false, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let enabled = defaults.object(forKey: Self.enabledKey) as? Bool ?? true
        let method = DeviceAuthentication.availableMethod()
        self.isEnabled = enabled
        self.method = method
        self.rule = AppLockRule(lockedAtLaunch: signedInAtLaunch && enabled && method != .unavailable)
    }

    var isCovered: Bool { rule.cover != .none }
    var isLocked: Bool { rule.isLocked }

    func setEnabled(_ enabled: Bool) {
        isEnabled = enabled
        defaults.set(enabled, forKey: Self.enabledKey)
        if !enabled { rule.unlock() }
    }

    /// Blurs on leaving the app; locks or reveals it on return.
    func scenePhaseChanged(to phase: ScenePhase, signedIn: Bool) {
        let wasLocked = rule.isLocked
        switch phase {
        case .inactive:
            rule.resignActive(applies: applies(signedIn: signedIn))
        case .background:
            rule.enterBackground(at: .now, applies: applies(signedIn: signedIn))
        case .active:
            // The passcode may have been set or removed in Settings meanwhile.
            method = DeviceAuthentication.availableMethod()
            rule.becomeActive(at: .now, applies: applies(signedIn: signedIn))
        @unknown default:
            break
        }
        if rule.isLocked, !wasLocked { promptsAutomatically = true }
    }

    /// The first ask of a lock, made as soon as the app is in front.
    func unlockAutomatically() async {
        guard promptsAutomatically else { return }
        promptsAutomatically = false
        await unlock()
    }

    /// Face ID or the passcode; the app stays locked when cancelled.
    func unlock() async {
        guard rule.isLocked, !isAuthenticating else { return }
        isAuthenticating = true
        defer { isAuthenticating = false }
        if await DeviceAuthentication.authenticate(reason: Self.unlockReason) {
            rule.unlock()
        }
    }

    /// Signing in or out shows the app as it is.
    func reset() {
        rule.unlock()
    }

    private func applies(signedIn: Bool) -> Bool {
        signedIn && isEnabled && method != .unavailable
    }
}
