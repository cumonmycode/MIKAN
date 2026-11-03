import Foundation

/// Payroll period chips: today, this month up to today, the whole previous month, or any range of days.
nonisolated enum PayrollPeriodOption: String, CaseIterable, Identifiable, Sendable, PeriodChipOption {
    case today
    case thisMonth
    case lastMonth
    case custom

    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: "Сегодня"
        case .thisMonth: "Этот месяц"
        case .lastMonth: "Прошлый месяц"
        case .custom: "Период"
        }
    }

    func range(now: Date = .now, customFrom: Date, customTo: Date, calendar: Calendar = .app) -> PayrollRange {
        let today = calendar.startOfDay(for: now)
        let monthStart = calendar.dateInterval(of: .month, for: now)?.start ?? today
        switch self {
        case .today:
            return PayrollRange(first: today, last: today)
        case .thisMonth:
            return PayrollRange(first: monthStart, last: today)
        case .lastMonth:
            let start = calendar.date(byAdding: .month, value: -1, to: monthStart) ?? monthStart
            let last = calendar.date(byAdding: .day, value: -1, to: monthStart) ?? monthStart
            return PayrollRange(first: start, last: last)
        case .custom:
            return PayrollRange(
                first: calendar.startOfDay(for: min(customFrom, customTo)),
                last: calendar.startOfDay(for: max(customFrom, customTo))
            )
        }
    }
}

/// What the period header edits: the chip and the custom range.
nonisolated struct PayrollPeriodSelection: Hashable, Sendable {
    var option: PayrollPeriodOption = .thisMonth
    var customFrom = Calendar.app.dateInterval(of: .month, for: .now)?.start ?? .now
    var customTo = Date.now

    func range(now: Date = .now) -> PayrollRange {
        option.range(now: now, customFrom: customFrom, customTo: customTo)
    }
}

/// Days from `first` to `last` inclusive (local day starts), sent to the server as studio dates.
nonisolated struct PayrollRange: Hashable, Sendable {
    let first: Date
    let last: Date

    var from: String { CalendarDay.string(from: first) }
    var to: String { CalendarDay.string(from: last) }

    /// `[first, last + 1 day)`.
    func interval(calendar: Calendar = .app) -> DateInterval {
        DateInterval(start: first, end: calendar.date(byAdding: .day, value: 1, to: last) ?? last)
    }

    /// Exactly one calendar month, first to last day.
    func isWholeMonth(calendar: Calendar = .app) -> Bool {
        guard let month = calendar.dateInterval(of: .month, for: first) else { return false }
        return calendar.isDate(first, inSameDayAs: month.start) && interval(calendar: calendar).end == month.end
    }

    /// «Сентябрь 2026» for a whole month, «Сегодня, 26 октября» for today, else «1 – 19 октября» or «15 октября».
    func title(now: Date = .now, calendar: Calendar = .app) -> String {
        if isWholeMonth(calendar: calendar) { return DateText.monthYear(first) }
        let days = ReportPeriod.rangeText(interval(calendar: calendar), now: now, calendar: calendar)
        let isToday = calendar.isDate(first, inSameDayAs: last) && calendar.isDate(first, inSameDayAs: now)
        return isToday ? "Сегодня, \(days)" : days
    }
}
