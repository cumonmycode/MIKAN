import Foundation

/// Editable hours of one day in minutes since midnight. Mirrors the server's checks (docs/API.md «WorkSchedule»):
/// the end after the start, breaks inside the hours and not overlapping, at most six of them.
nonisolated struct WorkHoursDraft: Hashable, Sendable {
    struct Pause: Hashable, Identifiable, Sendable {
        let id: UUID
        var start: Int
        var end: Int

        init(id: UUID = UUID(), start: Int, end: Int) {
            self.id = id
            self.start = start
            self.end = end
        }
    }

    static let maxBreaks = 6
    /// Picker step, minutes.
    static let step = 15
    static let defaultBreakMinutes = 30

    var start: Int
    var end: Int
    var breaks: [Pause]

    init(start: Int, end: Int, breaks: [Pause] = []) {
        self.start = start
        self.end = end
        self.breaks = breaks
    }

    /// The hours of a weekly entry or an exception; the studio hours when there are none (or they are malformed).
    init(_ hours: WorkHours?, studio: WorkdayHours) {
        guard let hours,
              let start = WorkdayHours.minute(from: hours.start),
              let end = WorkdayHours.minute(from: hours.end)
        else {
            self.init(start: studio.startMinute, end: studio.endMinute)
            return
        }
        let breaks = hours.breaks.compactMap { b -> Pause? in
            guard let s = WorkdayHours.minute(from: b.start), let e = WorkdayHours.minute(from: b.end) else { return nil }
            return Pause(start: s, end: e)
        }
        self.init(start: start, end: end, breaks: breaks)
    }

    static let startOptions = Array(stride(from: 0, through: TimeGridLayout.minutesPerDay - step, by: step))
    static let endOptions = Array(stride(from: step, through: TimeGridLayout.minutesPerDay, by: step))

    /// "HH:MM" hours with the breaks sorted, as the server stores them.
    var hours: WorkHours {
        WorkHours(
            start: WorkdayHours.text(fromMinute: start),
            end: WorkdayHours.text(fromMinute: end),
            breaks: breaks.sorted { $0.start < $1.start }.map {
                ScheduleTimeRange(start: WorkdayHours.text(fromMinute: $0.start), end: WorkdayHours.text(fromMinute: $0.end))
            }
        )
    }

    var canAddBreak: Bool { breaks.count < Self.maxBreaks && nextBreak != nil }

    /// Why the server would refuse these hours, in Russian; nil when they are fine.
    var problem: String? {
        let span = { (a: Int, b: Int) in "\(WorkdayHours.text(fromMinute: a))–\(WorkdayHours.text(fromMinute: b))" }
        if end <= start { return "Конец работы должен быть позже начала" }
        if breaks.count > Self.maxBreaks { return "Не больше \(Self.maxBreaks) перерывов" }
        let sorted = breaks.sorted { $0.start < $1.start }
        for (index, pause) in sorted.enumerated() {
            if pause.end <= pause.start { return "Конец перерыва должен быть позже начала" }
            if pause.start < start || pause.end > end {
                return "Перерыв \(span(pause.start, pause.end)) выходит за часы работы \(span(start, end))"
            }
            if index > 0, pause.start < sorted[index - 1].end {
                return "Перерывы \(span(sorted[index - 1].start, sorted[index - 1].end)) и \(span(pause.start, pause.end)) пересекаются"
            }
        }
        return nil
    }

    /// A half-hour break after the last one, else in the middle of the day; nil when the day has no room left.
    private var nextBreak: Pause? {
        let middle = (start + end) / 2 / Self.step * Self.step
        let from = max(breaks.map(\.end).max() ?? middle, start)
        let to = min(from + Self.defaultBreakMinutes, end)
        return from < to ? Pause(start: from, end: to) : nil
    }

    mutating func addBreak() {
        guard canAddBreak, let pause = nextBreak else { return }
        breaks.append(pause)
    }
}

/// Consecutive exception dates with the same content, shown as one row («23–25 октября · Выходной · Отпуск»).
nonisolated struct ScheduleExceptionGroup: Hashable, Identifiable, Sendable {
    let from: String
    let to: String
    let off: Bool
    let start: String?
    let end: String?
    let breaks: [ScheduleTimeRange]
    let note: String?

    var id: String { "\(from)…\(to)" }
    var title: String { WorkTimeText.dates(from: from, to: to) }
    var detail: String {
        guard !off, let start, let end else { return "Выходной" }
        return WorkTimeText.hours(start: start, end: end, breaks: breaks)
    }

    static func groups(_ days: [ScheduleException]) -> [ScheduleExceptionGroup] {
        var result: [ScheduleExceptionGroup] = []
        for day in days.sorted(by: { $0.date < $1.date }) {
            if let last = result.last, last.matches(day), nextDate(after: last.to) == day.date {
                result[result.count - 1] = last.extended(to: day.date)
            } else {
                result.append(ScheduleExceptionGroup(
                    from: day.date, to: day.date, off: day.off, start: day.start, end: day.end, breaks: day.breaks, note: day.note
                ))
            }
        }
        return result
    }

    private func matches(_ day: ScheduleException) -> Bool {
        off == day.off && start == day.start && end == day.end && breaks == day.breaks && note == day.note
    }

    private func extended(to date: String) -> ScheduleExceptionGroup {
        ScheduleExceptionGroup(from: from, to: date, off: off, start: start, end: end, breaks: breaks, note: note)
    }

    /// The calendar date after `date` ("YYYY-MM-DD"), counted in UTC so no time zone shifts it.
    static func nextDate(after date: String) -> String? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        guard let day = CalendarDay.date(from: date, calendar: calendar),
              let next = calendar.date(byAdding: .day, value: 1, to: day)
        else { return nil }
        return CalendarDay.string(from: next, calendar: calendar)
    }
}

/// A new exception: a day off, a vacation (a range of days off) or other hours on one date.
nonisolated struct ScheduleExceptionDraft: Hashable, Sendable {
    enum Kind: String, CaseIterable, Identifiable, Sendable {
        case dayOff, vacation, otherHours

        var id: String { rawValue }

        var title: String {
            switch self {
            case .dayOff: "Выходной"
            case .vacation: "Отпуск"
            case .otherHours: "Другие часы"
            }
        }
    }

    /// The server takes at most this many dates at once.
    static let maxDays = 62

    var kind: Kind = .dayOff
    var from: Date
    var to: Date
    var hours: WorkHoursDraft
    var note = ""

    init(day: Date, hours: WorkHoursDraft) {
        from = day
        to = day
        self.hours = hours
    }

    /// The last date the exception covers: only a vacation spans several days.
    var lastDay: Date { kind == .vacation ? to : from }

    func dayCount(calendar: Calendar) -> Int {
        let start = calendar.startOfDay(for: from)
        let finish = calendar.startOfDay(for: lastDay)
        return (calendar.dateComponents([.day], from: start, to: finish).day ?? 0) + 1
    }

    func problem(calendar: Calendar) -> String? {
        switch kind {
        case .dayOff:
            return nil
        case .vacation:
            let days = dayCount(calendar: calendar)
            if days < 1 { return "Последний день отпуска раньше первого" }
            if days > Self.maxDays { return "Не больше \(Self.maxDays) дней за раз — добавьте отпуск частями" }
            return nil
        case .otherHours:
            return hours.problem
        }
    }

    /// The request, or nil while there is a problem. A vacation without a note is noted «Отпуск».
    func body(calendar: Calendar) -> ScheduleDaysBody? {
        guard problem(calendar: calendar) == nil else { return nil }
        let first = CalendarDay.string(from: from, calendar: calendar)
        let last = CalendarDay.string(from: lastDay, calendar: calendar)
        let note = note.trimmed.nonEmpty ?? (kind == .vacation ? "Отпуск" : nil)
        guard kind == .otherHours else { return ScheduleDaysBody(from: first, to: last, off: true, note: note) }
        let hours = hours.hours
        return ScheduleDaysBody(from: first, to: first, off: false, start: hours.start, end: hours.end, breaks: hours.breaks, note: note)
    }
}
