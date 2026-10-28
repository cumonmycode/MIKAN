import SwiftUI

// Pure waitlist logic for the list «Лист ожидания»: sections by status and the Russian texts of an entry.

/// One status section of the list.
nonisolated struct WaitlistSection: Identifiable, Equatable, Sendable {
    let status: WaitlistStatus
    let entries: [WaitlistEntry]

    var id: WaitlistStatus { status }
}

/// The list «Лист ожидания»: open entries first, then the closed ones; each section oldest first.
nonisolated enum WaitlistGrouping {
    /// Section order.
    static let statuses: [WaitlistStatus] = [.waiting, .notified, .booked, .cancelled, .expired]

    /// Non-empty sections in `statuses` order, entries by creation (then id), one id once.
    static func sections(_ entries: [WaitlistEntry]) -> [WaitlistSection] {
        var seen = Set<Int>()
        let unique = entries.filter { seen.insert($0.id).inserted }
        return statuses.compactMap { status in
            let items = unique
                .filter { $0.status == status }
                .sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
            return items.isEmpty ? nil : WaitlistSection(status: status, entries: items)
        }
    }

    /// After a cancellation or an addition: the entry replaces the one with its id, or joins the list.
    static func applying(_ updated: WaitlistEntry, to entries: [WaitlistEntry]) -> [WaitlistEntry] {
        guard entries.contains(where: { $0.id == updated.id }) else { return entries + [updated] }
        return entries.map { $0.id == updated.id ? updated : $0 }
    }

    /// «Ждут», «Сообщили о времени», «Записались», «Отменены», «Истекли».
    static func title(_ status: WaitlistStatus) -> String {
        switch status {
        case .waiting: "Ждут"
        case .notified: "Сообщили о времени"
        case .booked: "Записались"
        case .cancelled: "Отменены"
        case .expired: "Истекли"
        }
    }
}

/// Russian texts of a waitlist entry.
nonisolated enum WaitlistText {
    /// «21 октября», «21–25 октября», «30 октября – 3 ноября», «28 декабря 2026 – 3 января 2027»; the year only
    /// when the range is not inside the current one. Unparsable dates are shown as they came.
    static func range(from: String, to: String, now: Date = .now, calendar: Calendar = .app) -> String {
        guard let first = CalendarDay.date(from: from, calendar: calendar),
              let last = CalendarDay.date(from: to, calendar: calendar) else {
            return from == to ? from : "\(from) – \(to)"
        }
        return range(first: first, last: max(first, last), now: now, calendar: calendar)
    }

    static func range(first: Date, last: Date, now: Date = .now, calendar: Calendar = .app) -> String {
        let style = Date.FormatStyle(locale: .app, calendar: calendar, timeZone: calendar.timeZone)
        let sameYear = calendar.isDate(first, equalTo: last, toGranularity: .year)
        let withYear = !sameYear || !calendar.isDate(last, equalTo: now, toGranularity: .year)
        let tail = last.formatted(withYear ? style.day().month(.wide).year() : style.day().month(.wide))
        if calendar.isDate(first, inSameDayAs: last) { return tail }
        if calendar.isDate(first, equalTo: last, toGranularity: .month) {
            return "\(first.formatted(style.day()))–\(tail)"
        }
        let head = first.formatted(sameYear ? style.day().month(.wide) : style.day().month(.wide).year())
        return "\(head) – \(tail)"
    }

    /// «Мочка — Два, Хеликс».
    static func services(_ items: [WaitlistItem]) -> String {
        items.map(\.title).joined(separator: ", ")
    }

    /// The master's name, or «Любой мастер».
    static func master(_ master: EmployeeRef?) -> String {
        master?.name ?? "Любой мастер"
    }

    /// Where the entry was made: «Приложение», «Бот», «Mini App», «Сайт».
    static func channel(_ channel: AppointmentChannel) -> String {
        switch channel {
        case .app: "Приложение"
        case .bot: "Бот"
        case .miniapp: "Mini App"
        case .web: "Сайт"
        case .other: "Другой канал"
        }
    }

    /// «Сообщили о времени 21 окт., 15:00».
    static func notified(_ date: Date) -> String {
        "Сообщили о времени \(DateText.dateTime(date))"
    }
}

extension WaitlistStatus {
    var color: Color {
        switch self {
        case .waiting: .orange
        case .notified: .blue
        case .booked: .green
        case .cancelled, .expired: .gray
        }
    }
}
