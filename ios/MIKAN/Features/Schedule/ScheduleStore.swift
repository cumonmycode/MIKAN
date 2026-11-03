import Foundation
import Observation

/// Appointments for one visible range, optionally filtered by master.
nonisolated struct ScheduleQuery: Hashable, Sendable {
    let start: Date
    let end: Date
    let masterId: Int?

    init(period: CalendarPeriod, masterId: Int?) {
        self.start = period.visibleStart
        self.end = period.visibleEnd
        self.masterId = masterId
    }

    func includes(_ appointment: Appointment) -> Bool {
        appointment.startsAt < end && appointment.endsAt > start
            && (masterId == nil || appointment.master.id == masterId)
    }
}

/// Calendar data: a small in-memory cache per visible range, prefetch of neighbours,
/// cancellation of stale requests while paging fast.
@Observable
final class ScheduleStore {
    private static let cacheLimit = 24
    /// Cached ranges older than this are refetched (in the background) when shown again.
    private static let staleAfter: TimeInterval = 30

    let api: APIClient
    private(set) var cache: [ScheduleQuery: [Appointment]] = [:]
    private(set) var loading: Set<ScheduleQuery> = []
    private(set) var errors: [ScheduleQuery: String] = [:]
    private(set) var visibleQuery: ScheduleQuery?
    /// Master filter for «Все записи».
    var masterFilter: Int?
    /// Today ± 7 days kept on the phone: shown at once and while offline (`ScheduleStore+Offline`).
    @ObservationIgnored var offlineSnapshot: ScheduleSnapshot?
    @ObservationIgnored var offlineWindowRequestedAt: Date?

    @ObservationIgnored private var tasks: [ScheduleQuery: (token: UUID, task: Task<Void, Never>)] = [:]
    @ObservationIgnored private var lastUsed: [ScheduleQuery: Date] = [:]
    @ObservationIgnored private var fetchedAt: [ScheduleQuery: Date] = [:]

    init(api: APIClient) {
        self.api = api
    }

    func appointments(for query: ScheduleQuery) -> [Appointment]? { cache[query] }
    func isLoading(_ query: ScheduleQuery) -> Bool { loading.contains(query) }
    func error(for query: ScheduleQuery) -> String? { errors[query] }

    /// Shows `visible`, prefetches `neighbours`, cancels every other request in flight.
    /// With `refresh`, the visible range is reloaded even if cached (cached data stays on screen).
    func focus(on visible: ScheduleQuery, prefetch neighbours: [ScheduleQuery], refresh: Bool = false) {
        visibleQuery = visible
        lastUsed[visible] = .now
        let wanted = Set([visible] + neighbours)
        for (query, entry) in tasks where !wanted.contains(query) {
            entry.task.cancel()
            tasks[query] = nil
            loading.remove(query)
        }
        start(visible, force: refresh || isStale(visible))
        neighbours.forEach { start($0, force: isStale($0)) }
    }

    /// Reloads a range and waits for it (pull-to-refresh).
    func reload(_ query: ScheduleQuery) async {
        let task = start(query, force: true)
        await task?.value
    }

    func refreshVisible() async {
        guard let visibleQuery else { return }
        await reload(visibleQuery)
    }

    /// Applies a created/edited appointment to every cached range (moving it out of ranges it left).
    func upsert(_ appointment: Appointment) {
        for (query, items) in cache {
            let others = items.filter { $0.id != appointment.id }
            cache[query] = query.includes(appointment)
                ? (others + [appointment]).sorted { $0.startsAt < $1.startsAt }
                : others
        }
        keepOffline(offlineSnapshot?.upserting(appointment))
    }

    /// The phone's copy, opened once the app is unlocked: ranges with nothing to show yet show it.
    func restore(_ snapshot: ScheduleSnapshot) {
        if offlineSnapshot == nil { offlineSnapshot = snapshot }
        let offline = api.connectivity?.isOnline == false
        let pending = loading.union(visibleQuery.map { [$0] } ?? [])
        for query in pending where cache[query] == nil {
            showSaved(query, offline: offline)
        }
    }

    /// Shows the phone's copy for a range: one inside the window always, one partly inside only offline (with a note).
    @discardableResult
    private func showSaved(_ query: ScheduleQuery, offline: Bool) -> Bool {
        guard let snapshot = offlineSnapshot, let saved = snapshot.appointments(for: query),
              offline || snapshot.covers(query) else { return false }
        cache[query] = saved
        errors[query] = offline ? snapshot.coverageNote(for: query) : nil
        return true
    }

    /// A failed load: offline, what is shown stays (the banner tells how old it is) or the phone's copy fills in.
    private func showFailure(_ error: any Error, for query: ScheduleQuery) {
        guard api.connectivity?.isOnline == false else {
            errors[query] = error.userMessage
            return
        }
        if cache[query] != nil {
            errors[query] = nil
        } else if !showSaved(query, offline: true) {
            errors[query] = error.userMessage
        }
    }

    private func isStale(_ query: ScheduleQuery) -> Bool {
        guard cache[query] != nil, tasks[query] == nil else { return false }
        return Date.now.timeIntervalSince(fetchedAt[query] ?? .distantPast) > Self.staleAfter
    }

    func reset() {
        tasks.values.forEach { $0.task.cancel() }
        tasks = [:]
        cache = [:]
        loading = []
        errors = [:]
        lastUsed = [:]
        fetchedAt = [:]
        visibleQuery = nil
        masterFilter = nil
        offlineSnapshot = nil
        offlineWindowRequestedAt = nil
    }

    // MARK: - Loading

    @discardableResult
    private func start(_ query: ScheduleQuery, force: Bool) -> Task<Void, Never>? {
        if let running = tasks[query] {
            guard force else { return running.task }
            running.task.cancel()
        } else if !force, cache[query] != nil {
            return nil
        }
        let token = UUID()
        loading.insert(query)
        let task = Task { [weak self] in
            guard let self else { return }
            await self.fetch(query, token: token)
        }
        tasks[query] = (token, task)
        if cache[query] == nil { showSaved(query, offline: false) }
        return task
    }

    private func fetch(_ query: ScheduleQuery, token: UUID) async {
        do {
            let items = try await api.appointments(from: query.start, to: query.end, masterId: query.masterId)
            if tasks[query]?.token == token || tasks[query] == nil {
                cache[query] = items
                errors[query] = nil
                lastUsed[query] = .now
                fetchedAt[query] = .now
                trimCache()
                keepOffline(offlineSnapshot?.merging(items, for: query))
            }
        } catch is CancellationError {
            // Superseded by paging or a newer refresh.
        } catch {
            if tasks[query]?.token == token { showFailure(error, for: query) }
        }
        if tasks[query]?.token == token {
            tasks[query] = nil
            loading.remove(query)
        }
    }

    private func trimCache() {
        guard cache.count > Self.cacheLimit else { return }
        let removable = cache.keys
            .filter { $0 != visibleQuery }
            .sorted { (lastUsed[$0] ?? .distantPast) < (lastUsed[$1] ?? .distantPast) }
            .prefix(cache.count - Self.cacheLimit)
        for query in removable {
            cache[query] = nil
            lastUsed[query] = nil
            fetchedAt[query] = nil
            errors[query] = nil
        }
    }
}
