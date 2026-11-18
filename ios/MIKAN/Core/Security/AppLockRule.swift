import Foundation

/// When the app hides behind a blur and asks for Face ID or the passcode (docs/API.md «Sessions»): after a launch and
/// after more than five minutes in the background. Leaving the app blurs it at once, so neither the app switcher nor
/// the way back shows any data; coming back sooner simply removes the blur. On a call or while the screen is shared the
/// blur waits for the background: the system's own interface keeps the scene inactive with the app still on screen.
nonisolated struct AppLockRule: Equatable, Sendable {
    enum Cover: Equatable, Sendable {
        /// The content is visible.
        case none
        /// Blurred while the app is not in front.
        case privacy
        /// Blurred until Face ID or the passcode unlocks it.
        case locked
    }

    /// Longer than this in the background locks the app.
    static let backgroundGrace: Duration = .seconds(5 * 60)

    private(set) var cover: Cover
    /// When the app last went to the background (cleared once it is back in front).
    private(set) var backgroundSince: ContinuousClock.Instant?

    /// The app starts locked when the lock applies, so its first frame already hides the content.
    init(lockedAtLaunch: Bool) {
        cover = lockedAtLaunch ? .locked : .none
    }

    var isLocked: Bool { cover == .locked }

    static func locks(afterBackground elapsed: Duration) -> Bool {
        elapsed > backgroundGrace
    }

    /// The app is leaving the front (inactive): the content hides.
    mutating func resignActive(applies: Bool) {
        if applies, cover == .none { cover = .privacy }
    }

    /// The app went to the background: the clock starts once per stay there.
    mutating func enterBackground(at instant: ContinuousClock.Instant, applies: Bool) {
        resignActive(applies: applies)
        if backgroundSince == nil { backgroundSince = instant }
    }

    /// Back in front: locked after more than five minutes away, otherwise visible again. A lock that no longer
    /// applies (switched off, signed out, no passcode) lets the content show.
    mutating func becomeActive(at instant: ContinuousClock.Instant, applies: Bool) {
        defer { backgroundSince = nil }
        guard applies else {
            cover = .none
            return
        }
        guard cover != .locked else { return }
        if let since = backgroundSince, Self.locks(afterBackground: since.duration(to: instant)) {
            cover = .locked
        } else {
            cover = .none
        }
    }

    /// The scene is inactive. Normally the app is leaving the front; with `staysOnScreen` (a call, a shared screen) the
    /// system's own interface is over the app, which is still on screen, so it counts as being in front.
    mutating func becomeInactive(at instant: ContinuousClock.Instant, applies: Bool, staysOnScreen: Bool) {
        if staysOnScreen {
            becomeActive(at: instant, applies: applies)
        } else {
            resignActive(applies: applies)
        }
    }

    /// Face ID or the passcode succeeded, or the lock was switched off or the employee signed out.
    mutating func unlock() {
        cover = .none
    }
}
