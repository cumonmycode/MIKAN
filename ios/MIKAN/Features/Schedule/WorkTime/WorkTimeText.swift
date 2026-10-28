import Foundation

/// Russian texts of the work schedules: hours with breaks, date ranges, a master's day.
nonisolated enum WorkTimeText {
    static let weekdays = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"]

    /// "перерыв 15:00–15:30" / "перерывы 13:00–13:30, 17:00–17:15"; nil without breaks.
    static func breaks(_ breaks: [ScheduleTimeRange]) -> String? {
        guard !breaks.isEmpty else { return nil }
        let list = breaks.map(\.title).joined(separator: ", ")
        return breaks.count == 1 ? "перерыв \(list)" : "перерывы \(list)"
    }

    /// "12:00–21:00, перерыв 15:00–15:30"
    static func hours(start: String, end: String, breaks: [ScheduleTimeRange]) -> String {
        ["\(start)–\(end)", Self.breaks(breaks)].compactMap { $0 }.joined(separator: ", ")
    }

    /// A weekly entry: hours with breaks, or «Выходной».
    static func hours(_ hours: WorkHours?) -> String {
        guard let hours else { return "Выходной" }
        return Self.hours(start: hours.start, end: hours.end, breaks: hours.breaks)
    }

    /// «23 октября», «23–25 октября», «30 октября – 2 ноября» for studio dates "YYYY-MM-DD".
    static func dates(from: String, to: String) -> String {
        guard let first = CalendarDay.date(from: from), let last = CalendarDay.date(from: to) else { return from }
        if from == to { return DateText.dayMonth(first) }
        let calendar = Calendar.app
        if calendar.isDate(first, equalTo: last, toGranularity: .month) {
            return "\(DateText.dayNumber(first))–\(DateText.dayMonth(last))"
        }
        if calendar.isDate(first, equalTo: last, toGranularity: .year) {
            return "\(DateText.dayMonth(first)) – \(DateText.dayMonth(last))"
        }
        return "\(DateText.fullDate(first)) – \(DateText.fullDate(last))"
    }

    /// «Фатима не работает в этот день (отпуск)» / «Фатима работает 12:00–21:00, перерыв 15:00–15:30».
    static func masterDay(_ day: ScheduleDay, name: String) -> String {
        guard day.working, let start = day.start, let end = day.end else {
            let note = day.note.map { " (\($0.lowercased()))" } ?? ""
            return "\(name) не работает в этот день\(note)"
        }
        return "\(name) работает \(hours(start: start, end: end, breaks: day.breaks))"
    }
}
