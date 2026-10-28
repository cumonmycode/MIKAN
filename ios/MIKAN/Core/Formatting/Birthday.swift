import Foundation

/// A client's birthday (docs/API.md «Collecting birthdays»): `YYYY-MM-DD`, where the year 1900 stands for «year unknown»
/// — then only the day and the month are shown, and no age is ever computed from it.
nonisolated struct Birthday: Equatable, Sendable {
    static let unknownYear = 1900
    /// A leap year to place a year-less date in, so 29 February exists.
    private static let referenceYear = 2000

    let day: Int
    let month: Int
    /// `nil` — the year is unknown (stored as 1900).
    let year: Int?

    /// `nil` for a day the month does not have (29 February only in a leap year or without the year).
    init?(day: Int, month: Int, year: Int?) {
        let known = year == Self.unknownYear ? nil : year
        guard (1...12).contains(month), (1...Self.daysIn(month: month, year: known)).contains(day) else { return nil }
        self.day = day
        self.month = month
        self.year = known
    }

    /// From the API's `YYYY-MM-DD`; `nil` for nothing or a malformed value.
    init?(_ value: String?) {
        guard let value else { return nil }
        let parts = value.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, value.count == 10 else { return nil }
        self.init(day: parts[2], month: parts[1], year: parts[0])
    }

    /// `YYYY-MM-DD` for the API, 1900 without the year.
    var string: String {
        String(format: "%04d-%02d-%02d", year ?? Self.unknownYear, month, day)
    }

    /// «12 апреля» when the year is unknown, else the full date as elsewhere in the app («12 апреля 1995 г.»).
    var text: String {
        guard let date else { return string }
        return year == nil ? DateText.dayMonth(date) : DateText.fullDate(date)
    }

    /// The day at local midnight; a year-less one in a leap year (only its day and month mean anything).
    var date: Date? {
        Calendar.app.date(from: DateComponents(year: year ?? Self.referenceYear, month: month, day: day))
    }

    /// Days in the month; without the year February has 29.
    static func daysIn(month: Int, year: Int?) -> Int {
        switch month {
        case 2:
            guard let year else { return 29 }
            return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 ? 29 : 28
        case 4, 6, 9, 11: return 30
        default: return 31
        }
    }

    /// «Апрель» — the month's name for the day-and-month picker.
    static func monthName(_ month: Int) -> String {
        let symbols = Calendar.app.standaloneMonthSymbols
        guard symbols.indices.contains(month - 1) else { return "\(month)" }
        let name = symbols[month - 1]
        return name.prefix(1).uppercased() + name.dropFirst()
    }
}
