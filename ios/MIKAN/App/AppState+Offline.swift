import Foundation
import os

// MARK: - Offline mode (docs/API.md «Offline mode (app)»)

extension AppState {
    /// While the server is not answering (the network itself is there), it is asked again this often.
    static let offlineTickInterval: Duration = .seconds(15)

    /// Once the signed-in app is unlocked (never before Face ID): opens the phone's copy, shows the saved schedule at
    /// once, then loads today ± 7 days from the server. Does nothing when the copy is already open.
    func openOfflineData() async {
        guard phase == .signedIn, !lock.isLocked else { return }
        let session = api.token
        guard await offlineCache.open() else { return }
        let newest = await offlineCache.newestSavedAt()
        let saved = await offlineCache.load(ScheduleSnapshot.self, .schedule)
        // Signed out (or in as someone else) meanwhile: nothing of this is shown.
        guard phase == .signedIn, api.token == session else { return }
        connectivity.restored(savedAt: newest)
        if let saved { schedule.restore(saved.payload) }
        if connectivity.isOnline { await schedule.refreshOfflineWindow() }
    }

    /// Back online: what is on screen is loaded again, and the cart's edits that could not be saved are sent.
    /// The till kept its cart and open receipts as they were the whole time.
    func refreshAfterReconnect() async {
        guard phase == .signedIn else { return }
        workSchedules.invalidate()
        async let calendar: Void = refreshScheduleAfterReconnect()
        async let references: Void = refreshReferencesAfterReconnect()
        async let till: Void = refreshTillAfterReconnect()
        async let shiftRefresh: Void = shift.refresh()
        async let badgesRefresh: Void = refreshBadges()
        _ = await (calendar, references, till, shiftRefresh, badgesRefresh)
    }

    /// Every few seconds while the signed-in app is in front: keeps the saved schedule fresh online, and asks a server
    /// that stopped answering whether it is back (any answer brings the app back online).
    func offlineTick() async {
        guard phase == .signedIn else { return }
        if connectivity.isOnline {
            await schedule.refreshOfflineWindowIfStale()
        } else if connectivity.state.needsProbe {
            await refreshBadges()
        }
    }

    /// Sign-out: the phone's copy is closed and deleted — another employee may sign in on this phone.
    func clearOfflineData() {
        connectivity.reset()
        let cache = offlineCache
        Task { await cache.wipe() }
    }

    private func refreshScheduleAfterReconnect() async {
        async let visible: Void = schedule.refreshVisible()
        async let window: Void = schedule.refreshOfflineWindow()
        _ = await (visible, window)
    }

    /// Reference data served from the phone's copy while offline is loaded again.
    private func refreshReferencesAfterReconnect() async {
        async let employees: Void = logFailure("Employees") { try await self.reference.ensureEmployees(force: true) }
        async let services: Void = logFailure("Services") { try await self.reference.ensureServices(force: true) }
        async let workday: Void = logFailure("Studio settings") { try await self.reference.ensureWorkday(force: true) }
        async let categories: Void = logFailure("Categories") { try await self.reference.ensureCategories(force: true) }
        _ = await (employees, services, workday, categories)
    }

    private func logFailure(_ what: String, _ load: () async throws -> Void) async {
        do {
            try await load()
        } catch is CancellationError {
            return
        } catch {
            Self.offlineLogger.notice("\(what, privacy: .public) refresh failed: \(error.userMessage, privacy: .public)")
        }
    }

    private static let offlineLogger = Logger(subsystem: "com.mikanstudio.crm", category: "offline")

    private func refreshTillAfterReconnect() async {
        await receipts.flush()
        await receipts.refreshQuietly()
    }
}
