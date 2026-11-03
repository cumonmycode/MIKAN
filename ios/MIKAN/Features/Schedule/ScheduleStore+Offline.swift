import Foundation
import os

// MARK: - The schedule kept on the phone (docs/API.md «Offline mode (app)»)

extension ScheduleStore {
    /// The whole window is loaded again after this long (pages loaded meanwhile are merged in anyway).
    nonisolated static let offlineWindowMaxAge: TimeInterval = 5 * 60
    /// A load of the window that failed is not repeated sooner than this.
    nonisolated static let offlineWindowRetryAfter: TimeInterval = 60

    /// Loads today ± 7 days of every master and keeps it on the phone: after unlocking, on getting back online, and
    /// when the copy is stale (`refreshOfflineWindowIfStale`). A failure keeps the previous copy.
    func refreshOfflineWindow(now: Date = .now) async {
        let window = ScheduleSnapshot.window(around: now)
        offlineWindowRequestedAt = now
        do {
            let items = try await api.appointments(from: window.start, to: window.end)
            keepOffline(ScheduleSnapshot(window: window, loadedAt: now, appointments: items))
        } catch is CancellationError {
            return
        } catch {
            Logger(subsystem: "com.mikanstudio.crm", category: "offline")
                .notice("Loading the offline schedule failed: \(error.userMessage, privacy: .public)")
        }
    }

    func refreshOfflineWindowIfStale(now: Date = .now) async {
        guard offlineSnapshot?.isStale(now: now, maxAge: Self.offlineWindowMaxAge) ?? true else { return }
        if let requested = offlineWindowRequestedAt, now.timeIntervalSince(requested) < Self.offlineWindowRetryAfter { return }
        await refreshOfflineWindow(now: now)
    }

    /// Takes a changed copy and saves it when it differs (`nil`: no copy yet, nothing to change).
    func keepOffline(_ snapshot: ScheduleSnapshot?) {
        guard let snapshot, snapshot != offlineSnapshot else { return }
        offlineSnapshot = snapshot
        guard let cache = api.offlineCache else { return }
        let savedAt = Date.now
        Task { await cache.save(snapshot, as: .schedule, at: savedAt) }
    }
}
