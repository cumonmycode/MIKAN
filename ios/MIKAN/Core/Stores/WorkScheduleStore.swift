import Foundation
import Observation
import os

/// Who works when, for the calendar: `GET /schedules` per studio date, loaded for the visible days and kept for a
/// few minutes. Failures (an older server, no connection) only leave the calendar unshaded.
@Observable
final class WorkScheduleStore {
    private static let staleAfter: TimeInterval = 5 * 60
    /// The server answers at most this many dates at once.
    static let maxDays = 62

    private let api: APIClient
    /// Studio date "YYYY-MM-DD" → every master's day, in the server's order (by name).
    private(set) var byDate: [String: [ScheduleDay]] = [:]
    /// Bumped by `invalidate()`: views key their loading task on it, so a changed schedule reloads at once.
    private(set) var generation = 0

    @ObservationIgnored private var fetchedAt: [String: Date] = [:]
    @ObservationIgnored private var inFlight: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private let logger = Logger(subsystem: "com.mikanstudio.crm", category: "schedules")

    init(api: APIClient) {
        self.api = api
    }

    func days(on date: String) -> [ScheduleDay] { byDate[date] ?? [] }

    func day(employeeId: Int, date: String) -> ScheduleDay? {
        byDate[date]?.first { $0.employeeId == employeeId }
    }

    /// Loads the dates that are missing or stale, as one request per run of at most `maxDays` dates.
    func ensure(dates: [String]) async {
        let now = Date.now
        let needed = dates.filter { now.timeIntervalSince(fetchedAt[$0] ?? .distantPast) > Self.staleAfter }.sorted()
        guard let from = needed.first, let to = needed.last else { return }
        let key = "\(from)…\(to)"
        if let running = inFlight[key] {
            await running.value
            return
        }
        let task = Task { [weak self] in
            guard let self else { return }
            await self.fetch(from: from, to: to, dates: needed)
        }
        inFlight[key] = task
        await task.value
        inFlight[key] = nil
    }

    /// After a schedule changed: everything is fetched again when shown.
    func invalidate() {
        fetchedAt = [:]
        generation += 1
    }

    func reset() {
        inFlight.values.forEach { $0.cancel() }
        inFlight = [:]
        fetchedAt = [:]
        byDate = [:]
        generation += 1
    }

    private func fetch(from: String, to: String, dates: [String]) async {
        do {
            let items = try await api.schedules(from: from, to: to)
            let grouped = Dictionary(grouping: items, by: \.date)
            for date in dates { byDate[date] = grouped[date] ?? [] }
        } catch is CancellationError {
            return
        } catch {
            logger.notice("Schedules \(from, privacy: .public)…\(to, privacy: .public) failed: \(error.userMessage, privacy: .public)")
        }
        // A failure is retried after the same pause, not on every scroll.
        let now = Date.now
        for date in dates { fetchedAt[date] = now }
    }
}
