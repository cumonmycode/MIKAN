import Foundation

/// Texts and numbers of the «Рост» cards (pure, so they are unit-tested).
nonisolated enum GrowthText {
    /// One bar of a funnel: how many reached a step and their share of the first step.
    struct Step: Identifiable, Equatable, Sendable {
        let id: String
        let title: String
        let count: Int
        /// 0…1 of the first step.
        let fraction: Double
        /// «75 %» of the first step, «—» when it is empty.
        let percent: String
    }

    // MARK: Numbers

    /// «65 %», «—» when unknown; rounded to a whole percent.
    static func wholePercent(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return Int(value.rounded()).formatted(.number.locale(.app)) + "\u{00A0}%"
    }

    /// «75 %» — `part` of `whole`; «—» when the whole is not positive.
    static func conversion(_ part: Int, of whole: Int) -> String {
        whole > 0 ? wholePercent(Double(part) * 100 / Double(whole)) : "—"
    }

    /// `part / whole`, clamped to 0…1 (a bar never overflows); 0 when the whole is not positive.
    static func fraction(_ part: Int, of whole: Int) -> Double {
        min(max(ReportText.share(part, of: whole), 0), 1)
    }

    /// «2,1» — one decimal at most.
    static func decimal(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...1)).locale(.app))
    }

    /// «45 мин», «12 ч», «12 ч 30 мин», «1 250 ч».
    static func duration(minutes: Int) -> String {
        let total = max(minutes, 0)
        let hours = total / 60
        let rest = total % 60
        guard hours > 0 else { return "\(rest)\u{00A0}мин" }
        let head = hours.formatted(.number.locale(.app)) + "\u{00A0}ч"
        return rest > 0 ? "\(head) \(rest)\u{00A0}мин" : head
    }

    // MARK: Funnel

    private static func steps(_ parts: [(id: String, title: String, count: Int)]) -> [Step] {
        let first = parts.first?.count ?? 0
        return parts.map { Step(id: $0.id, title: $0.title, count: $0.count, fraction: fraction($0.count, of: first), percent: conversion($0.count, of: first)) }
    }

    /// Online bookings: created → confirmed → the visit took place.
    static func onlineSteps(_ online: GrowthOnline) -> [Step] {
        steps([
            (id: "created", title: "Записались онлайн", count: online.created),
            (id: "confirmed", title: "Подтверждены", count: online.confirmed),
            (id: "completed", title: "Пришли", count: online.completed),
        ])
    }

    /// Where online bookings were lost: «Отклонены: 2 · Не оплачены вовремя: 1 · …»; `nil` when nowhere.
    static func onlineLosses(_ online: GrowthOnline) -> String? {
        joined([
            ("Отклонены", online.rejected),
            ("Не оплачены вовремя", online.expired),
            ("Отменены клиентом", online.cancelledByClient),
            ("Ждут ответа", online.awaiting),
        ])
    }

    /// Booking requests of the bot: created → processed.
    static func requestSteps(_ requests: GrowthRequests) -> [Step] {
        steps([
            (id: "created", title: "Заявки из бота", count: requests.created),
            (id: "processed", title: "Обработаны", count: requests.processed),
        ])
    }

    static func requestLosses(_ requests: GrowthRequests) -> String? {
        joined([("Отклонены", requests.rejected), ("Ждут обработки", requests.open)])
    }

    /// Every appointment booked in the period and what became of it.
    static func appointmentSteps(_ appointments: GrowthAppointments) -> [Step] {
        steps([
            (id: "created", title: "Записей создано", count: appointments.created),
            (id: "completed", title: "Состоялись", count: appointments.completed),
            (id: "cancelled", title: "Отменены", count: appointments.cancelled),
            (id: "noShow", title: "Неявки", count: appointments.noShow),
        ])
    }

    private static func joined(_ parts: [(String, Int)]) -> String? {
        let visible = parts.filter { $0.1 > 0 }.map { "\($0.0): \($0.1)" }
        return visible.isEmpty ? nil : visible.joined(separator: " · ")
    }

    // MARK: Channels

    private static let channelOrder = ["app", "web", "miniapp", "bot"]

    /// «Приложение», «Сайт», «Mini App», «Бот»; a channel added later by its raw name.
    static func channelTitle(_ channel: String) -> String {
        switch channel {
        case "app": "Приложение"
        case "web": "Сайт"
        case "miniapp": "Mini App"
        case "bot": "Бот"
        default: channel
        }
    }

    /// Channels that booked anything, known ones first in a fixed order, then the rest by name.
    static func channels(_ byChannel: [String: Int]) -> [(channel: String, count: Int)] {
        byChannel
            .filter { $0.value > 0 }
            .sorted { a, b in
                let ia = channelOrder.firstIndex(of: a.key) ?? channelOrder.count
                let ib = channelOrder.firstIndex(of: b.key) ?? channelOrder.count
                return ia != ib ? ia < ib : a.key < b.key
            }
            .map { (channel: $0.key, count: $0.value) }
    }

    /// «Приложение 60 · Сайт 5 · Mini App 7 · Бот 8»; `nil` when nothing was booked.
    static func channelLine(_ byChannel: [String: Int]) -> String? {
        let parts = channels(byChannel).map { "\(channelTitle($0.channel)) \($0.count)" }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // MARK: Load

    /// Seven weekdays, Monday first; a weekday the server left out is zero.
    static func weekdays(_ load: GrowthMasterLoad) -> [GrowthWeekdayLoad] {
        (1...7).map { weekday in load.byWeekday.first { $0.weekday == weekday } ?? GrowthWeekdayLoad(weekday: weekday) }
    }

    /// «Занято 104 ч из 160 ч · проведено 90 ч»; without working time — what was booked anyway.
    static func loadDetail(_ load: GrowthMasterLoad) -> String {
        guard load.workingMinutes > 0 else {
            return load.bookedMinutes > 0 ? "Нет рабочего времени по графику · записей на \(duration(minutes: load.bookedMinutes))" : "Нет рабочего времени по графику"
        }
        return "Занято \(duration(minutes: load.bookedMinutes)) из \(duration(minutes: load.workingMinutes)) · проведено \(duration(minutes: load.completedMinutes))"
    }

    /// Bar of a master's load, 0…1 (over 100 % fills it).
    static func loadFraction(_ load: GrowthMasterLoad) -> Double {
        min(max((load.loadPercent ?? 0) / 100, 0), 1)
    }

    /// Load of one weekday, «—» without working time.
    static func weekdayPercent(_ day: GrowthWeekdayLoad) -> String {
        conversion(day.bookedMinutes, of: day.workingMinutes)
    }

    // MARK: Retention and sources

    private static let monthShort = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"]

    /// "2025-09" → «Сен 2025»; anything else as is.
    static func monthTitle(_ month: String) -> String {
        let parts = month.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2, (1...12).contains(parts[1]) else { return month }
        return "\(monthShort[parts[1] - 1]) \(parts[0])"
    }

    /// Whether every client of a cohort month has had `days` days to come back by `now` (its cells are final).
    static func cohortWindowClosed(month: String, days: Int, now: Date = .now, calendar: Calendar = .app) -> Bool {
        let parts = month.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2,
              let start = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: 1)),
              let nextMonth = calendar.date(byAdding: .month, value: 1, to: start),
              let closes = calendar.date(byAdding: .day, value: days, to: nextMonth)
        else { return true }
        return now >= closes
    }

    /// The server sends sources trimmed and lower-cased: «Instagram», «Рекомендация», «Не указан».
    static func sourceTitle(_ source: String) -> String {
        let trimmed = source.trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.first else { return "Не указан" }
        return first.uppercased() + trimmed.dropFirst()
    }

    /// By new clients, then revenue, then name (the server's order, kept for older servers too).
    static func sortedSources(_ sources: [GrowthSource]) -> [GrowthSource] {
        sources.sorted { a, b in
            if a.newClients != b.newClients { return a.newClients > b.newClients }
            if a.revenue != b.revenue { return a.revenue > b.revenue }
            return a.source < b.source
        }
    }

    /// «1 клиент», «3 клиента», «5 клиентов».
    static func clients(_ count: Int) -> String {
        Plural.count(count, one: "клиент", few: "клиента", many: "клиентов")
    }
}

/// Colour scale of the cohort table: each cell is tinted by its share of returns relative to the table's best cell.
nonisolated enum GrowthHeatScale {
    /// The return windows of the table, in days.
    static let windows = [30, 90, 180]
    /// Faintest tint of a cell with clients (0 % returned still reads as a filled cell).
    static let minimumOpacity = 0.08
    static let maximumOpacity = 0.85
    /// From this intensity on the cell's text is white.
    static let lightTextThreshold = 0.6

    /// Share of the cohort that returned within `days`, 0…1; `nil` without clients.
    static func share(_ cohort: GrowthCohort, days: Int) -> Double? {
        cohort.clients > 0 ? Double(cohort.returned(within: days)) / Double(cohort.clients) : nil
    }

    /// The best share in the table (0 when no cohort has clients).
    static func maximum(_ cohorts: [GrowthCohort]) -> Double {
        cohorts.flatMap { cohort in windows.compactMap { share(cohort, days: $0) } }.max() ?? 0
    }

    /// 0…1: `value` relative to `maximum`; 0 for `nil` or a table without returns.
    static func intensity(_ value: Double?, maximum: Double) -> Double {
        guard let value, maximum > 0, value.isFinite else { return 0 }
        return min(max(value / maximum, 0), 1)
    }

    /// Background opacity of a cell for an intensity, from `minimumOpacity` to `maximumOpacity`.
    static func opacity(_ intensity: Double) -> Double {
        minimumOpacity + (maximumOpacity - minimumOpacity) * min(max(intensity, 0), 1)
    }

    static func prefersLightText(_ intensity: Double) -> Bool {
        intensity >= lightTextThreshold
    }
}
