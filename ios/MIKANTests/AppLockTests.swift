import Foundation
import Testing
@testable import MIKAN

/// The Face ID lock (docs/API.md «Sessions»): locked after a launch and after more than five minutes in the
/// background; leaving the app blurs it at once.
struct AppLockRuleTests {
    private let start = ContinuousClock.now

    @Test("A launch with a saved session starts locked; without one nothing is covered")
    func launch() {
        #expect(AppLockRule(lockedAtLaunch: true).cover == .locked)
        #expect(AppLockRule(lockedAtLaunch: false).cover == .none)
    }

    @Test("Leaving the app blurs it at once, before any time passes")
    func leavingBlurs() {
        var rule = AppLockRule(lockedAtLaunch: false)
        rule.resignActive(applies: true)
        #expect(rule.cover == .privacy)
        rule.enterBackground(at: start, applies: true)
        #expect(rule.cover == .privacy)
        #expect(rule.backgroundSince == start)
    }

    @Test("Back within five minutes: the blur goes, no Face ID", arguments: [0, 60, 299, 300])
    func shortStay(seconds: Int) {
        var rule = AppLockRule(lockedAtLaunch: false)
        rule.enterBackground(at: start, applies: true)
        rule.becomeActive(at: start + .seconds(seconds), applies: true)
        #expect(rule.cover == .none)
        #expect(rule.backgroundSince == nil)
    }

    @Test("Back after more than five minutes: locked", arguments: [301, 3_600, 86_400])
    func longStay(seconds: Int) {
        var rule = AppLockRule(lockedAtLaunch: false)
        rule.resignActive(applies: true)
        rule.enterBackground(at: start, applies: true)
        rule.becomeActive(at: start + .seconds(seconds), applies: true)
        #expect(rule.cover == .locked)
    }

    @Test("The threshold is strictly more than five minutes")
    func threshold() {
        #expect(!AppLockRule.locks(afterBackground: .seconds(300)))
        #expect(AppLockRule.locks(afterBackground: .seconds(300) + .milliseconds(1)))
        #expect(AppLockRule.backgroundGrace == .seconds(5 * 60))
    }

    @Test("The clock starts at the first background moment of a stay")
    func firstBackgroundMoment() {
        var rule = AppLockRule(lockedAtLaunch: false)
        rule.enterBackground(at: start, applies: true)
        rule.enterBackground(at: start + .seconds(200), applies: true)
        rule.becomeActive(at: start + .seconds(301), applies: true)
        #expect(rule.cover == .locked)
    }

    @Test("Inactive without the background (Control Center, the Face ID prompt) never locks")
    func inactiveOnly() {
        var rule = AppLockRule(lockedAtLaunch: false)
        rule.resignActive(applies: true)
        rule.becomeActive(at: start + .seconds(3_600), applies: true)
        #expect(rule.cover == .none)
    }

    @Test("A lock stays until unlocked, whatever the scene does meanwhile")
    func lockStays() {
        var rule = AppLockRule(lockedAtLaunch: true)
        rule.resignActive(applies: true)
        rule.becomeActive(at: start, applies: true)
        #expect(rule.cover == .locked)
        rule.enterBackground(at: start, applies: true)
        rule.becomeActive(at: start + .seconds(1), applies: true)
        #expect(rule.cover == .locked)
        rule.unlock()
        #expect(rule.cover == .none)
    }

    @Test("Each stay is measured on its own after an unlock")
    func freshStayAfterUnlock() {
        var rule = AppLockRule(lockedAtLaunch: false)
        rule.enterBackground(at: start, applies: true)
        rule.becomeActive(at: start + .seconds(400), applies: true)
        rule.unlock()
        rule.enterBackground(at: start + .seconds(500), applies: true)
        rule.becomeActive(at: start + .seconds(560), applies: true)
        #expect(rule.cover == .none)
    }

    @Test("Switched off, signed out or no passcode: no blur and no lock")
    func notApplying() {
        var rule = AppLockRule(lockedAtLaunch: false)
        rule.resignActive(applies: false)
        rule.enterBackground(at: start, applies: false)
        #expect(rule.cover == .none)
        rule.becomeActive(at: start + .seconds(3_600), applies: false)
        #expect(rule.cover == .none)

        var locked = AppLockRule(lockedAtLaunch: true)
        locked.becomeActive(at: start, applies: false)
        #expect(locked.cover == .none)
    }
}
