import Foundation

/// Publication moments in the studio time zone (Titan `mskToPicker` / `dayTitle`): the API takes `date` + `time`
/// there, so pickers run in that zone too (`.environment(\.timeZone, …)`).
nonisolated enum SmmClock {
    /// A post without a time goes out at noon.
    static let defaultHour = 12

    private static let weekdays = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"]

    private static func calendar(_ timeZone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    /// `YYYY-MM-DD` at `hour:minute` in the studio time zone.
    static func date(day: String, hour: Int = defaultHour, minute: Int = 0, in timeZone: TimeZone) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        let components = DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: hour, minute: minute)
        return calendar(timeZone).date(from: components)
    }

    /// Tomorrow at noon in the studio time zone — the default for a post without a date.
    static func tomorrowNoon(in timeZone: TimeZone, now: Date = .now) -> Date {
        let calendar = calendar(timeZone)
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
        return calendar.date(bySettingHour: defaultHour, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }

    /// The given day at noon (a day of the plan); without one, or when that moment has passed, — tomorrow at noon.
    static func publishDate(day: String?, in timeZone: TimeZone, now: Date = .now) -> Date {
        guard let day, let date = date(day: day, in: timeZone), date > now else {
            return tomorrowNoon(in: timeZone, now: now)
        }
        return date
    }

    /// «Сегодня · 28 октября, ср», «Завтра · 29 октября, чт», «30 октября, пт» of a `YYYY-MM-DD` day.
    static func dayTitle(_ day: String, in timeZone: TimeZone, now: Date = .now) -> String {
        let calendar = calendar(timeZone)
        var label = SmmText.dayTitle(day)
        if let date = date(day: day, in: timeZone) {
            let weekday = calendar.component(.weekday, from: date)
            label += ", \(weekdays[(weekday - 1) % 7])"
        }
        let today = SmmText.dayKey(of: now, in: timeZone)
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: now).map { SmmText.dayKey(of: $0, in: timeZone) }
        if day == today { return "Сегодня · \(label)" }
        if day == tomorrow { return "Завтра · \(label)" }
        return label
    }
}
