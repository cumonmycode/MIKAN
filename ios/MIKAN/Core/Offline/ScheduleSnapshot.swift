import Foundation

/// The schedule kept on the phone (docs/API.md «Offline mode (app)»): every master's appointments, with their
/// details, from 7 days before today to 7 days after. Shown at once on launch and whenever the server can't be
/// reached; every calendar page loaded from the server is merged in.
nonisolated struct ScheduleSnapshot: Codable, Equatable, Sendable {
    static let daysAround = 7

    /// Local midnight `daysAround` days before the day the window was loaded.
    let windowStart: Date
    /// Exclusive: local midnight after the last day.
    let windowEnd: Date
    /// When the whole window was last loaded (merging a calendar page keeps it).
    let loadedAt: Date
    /// Appointments touching the window, by start.
    private(set) var appointments: [Appointment]

    init(window: DateInterval, loadedAt: Date, appointments: [Appointment]) {
        windowStart = window.start
        windowEnd = window.end
        self.loadedAt = loadedAt
        self.appointments = appointments
            .filter { $0.startsAt < window.end && $0.endsAt > window.start }
            .sorted { $0.startsAt == $1.startsAt ? $0.id < $1.id : $0.startsAt < $1.startsAt }
    }

    var window: DateInterval { DateInterval(start: windowStart, end: windowEnd) }

    /// From local midnight 7 days before `now`'s day to the end of the 7th day after it.
    static func window(around now: Date, calendar: Calendar = .app) -> DateInterval {
        let today = calendar.startOfDay(for: now)
        let start = calendar.date(byAdding: .day, value: -daysAround, to: today) ?? today
        let end = calendar.date(byAdding: .day, value: daysAround + 1, to: today) ?? today
        return DateInterval(start: start, end: end)
    }

    /// Loaded longer than `maxAge` ago, or on another day (the window has moved on).
    func isStale(now: Date, maxAge: TimeInterval, calendar: Calendar = .app) -> Bool {
        now.timeIntervalSince(loadedAt) > maxAge || Self.window(around: now, calendar: calendar).start != windowStart
    }

    /// The whole range lies inside the window.
    func covers(_ query: ScheduleQuery) -> Bool {
        query.start >= windowStart && query.end <= windowEnd
    }

    func overlaps(_ query: ScheduleQuery) -> Bool {
        query.start < windowEnd && query.end > windowStart
    }

    /// What the copy has for a calendar page; `nil` when the page lies outside the window.
    func appointments(for query: ScheduleQuery) -> [Appointment]? {
        guard overlaps(query) else { return nil }
        return appointments.filter { query.includes($0) }
    }

    func appointment(id: Int) -> Appointment? {
        appointments.first { $0.id == id }
    }

    /// Without a network, a page only partly inside the window shows what there is and says so.
    func coverageNote(for query: ScheduleQuery, calendar: Calendar = .app) -> String? {
        guard overlaps(query), !covers(query) else { return nil }
        let lastDay = calendar.date(byAdding: .day, value: -1, to: windowEnd) ?? windowEnd
        return "Без сети видны записи только с \(DateText.dayMonth(windowStart)) по \(DateText.dayMonth(lastDay))"
    }

    /// Takes a calendar page loaded from the server: what the copy had in that range is replaced by it.
    func merging(_ loaded: [Appointment], for query: ScheduleQuery) -> ScheduleSnapshot {
        guard overlaps(query) else { return self }
        let fresh = Set(loaded.map(\.id))
        let kept = appointments.filter { !query.includes($0) && !fresh.contains($0.id) }
        return replacing(with: kept + loaded)
    }

    /// An appointment created or changed in the app (one moved out of the window leaves it).
    func upserting(_ appointment: Appointment) -> ScheduleSnapshot {
        replacing(with: appointments.filter { $0.id != appointment.id } + [appointment])
    }

    private func replacing(with items: [Appointment]) -> ScheduleSnapshot {
        ScheduleSnapshot(window: window, loadedAt: loadedAt, appointments: items)
    }
}
