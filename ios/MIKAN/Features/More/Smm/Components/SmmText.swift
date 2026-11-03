import Foundation

/// Month keys, dates in the studio time zone (the API takes `date` + `time` there) and post text helpers.
/// Pass `ReferenceStore.workday.timeZone` as the studio time zone.
nonisolated enum SmmText {
    private static let monthNames = [
        "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
        "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
    ]
    private static let monthGenitive = [
        "января", "февраля", "марта", "апреля", "мая", "июня",
        "июля", "августа", "сентября", "октября", "ноября", "декабря",
    ]
    private static let weekdays = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"]

    private static func calendar(_ timeZone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    private static func pad(_ value: Int) -> String {
        value < 10 ? "0\(value)" : "\(value)"
    }

    /// `YYYY-MM` of the moment in the studio time zone.
    static func monthKey(of date: Date, in timeZone: TimeZone) -> String {
        let parts = calendar(timeZone).dateComponents([.year, .month], from: date)
        return "\(parts.year ?? 1970)-\(pad(parts.month ?? 1))"
    }

    /// `YYYY-MM-DD` of the moment in the studio time zone.
    static func dayKey(of date: Date, in timeZone: TimeZone) -> String {
        let parts = calendar(timeZone).dateComponents([.year, .month, .day], from: date)
        return "\(parts.year ?? 1970)-\(pad(parts.month ?? 1))-\(pad(parts.day ?? 1))"
    }

    /// `HH:mm` of the moment in the studio time zone.
    static func timeKey(of date: Date, in timeZone: TimeZone) -> String {
        let parts = calendar(timeZone).dateComponents([.hour, .minute], from: date)
        return "\(pad(parts.hour ?? 0)):\(pad(parts.minute ?? 0))"
    }

    /// «2026-11» → «Ноябрь 2026».
    static func monthTitle(_ month: String) -> String {
        let pieces = month.split(separator: "-")
        guard pieces.count >= 2, let number = Int(pieces[1]), (1...12).contains(number) else { return month }
        return "\(monthNames[number - 1]) \(pieces[0])"
    }

    /// «2026-11» shifted by `delta` months.
    static func shiftMonth(_ month: String, by delta: Int) -> String {
        let pieces = month.split(separator: "-").compactMap { Int($0) }
        guard pieces.count >= 2 else { return month }
        let index = pieces[0] * 12 + (pieces[1] - 1) + delta
        let year = Int((Double(index) / 12).rounded(.down))
        return "\(year)-\(pad(index - year * 12 + 1))"
    }

    /// «пн, 15 октября, 12:00» in the studio time zone; «Без даты» without one.
    static func when(_ date: Date?, in timeZone: TimeZone) -> String {
        guard let date else { return "Без даты" }
        let parts = calendar(timeZone).dateComponents([.month, .day, .weekday, .hour, .minute], from: date)
        let weekday = weekdays[((parts.weekday ?? 1) - 1) % 7]
        let month = monthGenitive[((parts.month ?? 1) - 1) % 12]
        return "\(weekday), \(parts.day ?? 1) \(month), \(pad(parts.hour ?? 0)):\(pad(parts.minute ?? 0))"
    }

    /// «15 октября» of a `YYYY-MM-DD` or `MM-DD` day; a yearly `MM-DD` adds «, каждый год».
    static func dayTitle(_ day: String) -> String {
        let pieces = day.split(separator: "-").compactMap { Int($0) }
        guard pieces.count >= 2 else { return day }
        let month = pieces[pieces.count - 2]
        let date = pieces[pieces.count - 1]
        guard (1...12).contains(month) else { return day }
        let text = "\(date) \(monthGenitive[month - 1])"
        return pieces.count == 2 ? "\(text), каждый год" : text
    }

    /// «12 345».
    static func count(_ value: Int) -> String {
        value.formatted(.number.locale(.app))
    }

    /// Post text without Telegram markup — for previews and for copying into Instagram.
    static func plainText(_ body: String) -> String {
        let rules: [(pattern: String, template: String)] = [
            ("<br\\s*/?>", "\n"),
            ("<a\\s[^>]*>([^<]*)</a>", "$1"),
            ("<[^>]+>", ""),
        ]
        var text = body
        for rule in rules {
            text = text.replacingOccurrences(
                of: rule.pattern, with: rule.template, options: [.regularExpression, .caseInsensitive]
            )
        }
        let entities = [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&amp;", "&")]
        for (entity, character) in entities {
            text = text.replacingOccurrences(of: entity, with: character)
        }
        return text.trimmed
    }
}
