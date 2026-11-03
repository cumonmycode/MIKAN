import Foundation

/// Why a waitlist date range is refused (the server's rules, checked before sending).
nonisolated enum WaitlistRangeError: Error, Equatable, Sendable {
    case startInPast
    case endBeforeStart
    case tooLong
    case tooFar

    var message: String {
        switch self {
        case .startInPast: "Начало периода уже прошло — выберите даты с сегодняшнего дня."
        case .endBeforeStart: "Конец периода должен быть не раньше начала."
        case .tooLong: "Период — не больше \(WaitlistRange.maxDays) дней."
        case .tooFar: "Лист ожидания — не дальше чем на год вперёд."
        }
    }
}

/// The date range of an entry: from today, at most 30 days inclusive, staff up to 365 days ahead.
nonisolated enum WaitlistRange {
    static let maxDays = 30
    /// How far ahead staff may put a wish, days from today (the server's limit).
    static let staffAheadDays = 365
    /// Days in the range offered by default: the next two weeks, as on the booking page.
    static let defaultDays = 14

    /// Days from `from` to `to` inclusive (the same day is 1).
    static func days(from: Date, to: Date, calendar: Calendar = .app) -> Int {
        let start = calendar.startOfDay(for: from)
        let end = calendar.startOfDay(for: to)
        return (calendar.dateComponents([.day], from: start, to: end).day ?? 0) + 1
    }

    /// The last day staff may pick.
    static func lastDay(today: Date, calendar: Calendar = .app) -> Date {
        let start = calendar.startOfDay(for: today)
        return calendar.date(byAdding: .day, value: staffAheadDays, to: start) ?? start
    }

    /// The first rule the range breaks, or `nil` when it may be sent.
    static func validate(from: Date, to: Date, today: Date = .now, calendar: Calendar = .app) -> WaitlistRangeError? {
        let start = calendar.startOfDay(for: from)
        let end = calendar.startOfDay(for: to)
        if start < calendar.startOfDay(for: today) { return .startInPast }
        if end < start { return .endBeforeStart }
        if days(from: start, to: end, calendar: calendar) > maxDays { return .tooLong }
        if end > lastDay(today: today, calendar: calendar) { return .tooFar }
        return nil
    }
}

/// A wanted catalog service of the draft: one per service, with the variant for a service that has variants.
nonisolated struct WaitlistDraftItem: Hashable, Sendable {
    let serviceId: Int
    let variant: String?
    /// «Мочка — Два».
    let title: String
}

/// The sheet «В лист ожидания»: a client, 1–5 services, a master or any, dates and a note.
nonisolated struct WaitlistDraft: Equatable, Sendable {
    static let maxItems = 5
    static let maxNoteLength = 500

    var client: ClientRef?
    private(set) var items: [WaitlistDraftItem] = []
    /// `nil` — any master.
    var masterId: Int?
    var dateFrom: Date {
        didSet {
            // The end follows a start moved past it, so the range stays a range.
            if dateTo < dateFrom { dateTo = dateFrom }
        }
    }
    var dateTo: Date
    var note = ""

    init(client: ClientRef? = nil, today: Date = .now, calendar: Calendar = .app) {
        let start = calendar.startOfDay(for: today)
        self.client = client
        self.dateFrom = start
        self.dateTo = calendar.date(byAdding: .day, value: WaitlistRange.defaultDays - 1, to: start) ?? start
    }

    var canAddItem: Bool { items.count < Self.maxItems }

    func item(serviceId: Int) -> WaitlistDraftItem? {
        items.first { $0.serviceId == serviceId }
    }

    /// A service without variants: removes it, or adds it while there is room.
    mutating func toggle(service: Service) {
        if item(serviceId: service.id) != nil {
            remove(serviceId: service.id)
        } else {
            select(service: service, variant: nil)
        }
    }

    /// Picks the variant (or the plain service), replacing the service's current choice in place.
    mutating func select(service: Service, variant: ServiceVariant?) {
        let item = WaitlistDraftItem(serviceId: service.id, variant: variant?.name, title: service.lineName(variant: variant))
        if let index = items.firstIndex(where: { $0.serviceId == service.id }) {
            items[index] = item
        } else if canAddItem {
            items.append(item)
        }
    }

    mutating func remove(serviceId: Int) {
        items.removeAll { $0.serviceId == serviceId }
    }

    mutating func remove(at offsets: IndexSet) {
        items = items.enumerated().filter { !offsets.contains($0.offset) }.map(\.element)
    }

    /// The first thing to fix before sending, as shown under the form; `nil` when it may be sent.
    func validationMessage(today: Date = .now, calendar: Calendar = .app) -> String? {
        if client == nil { return "Выберите клиента." }
        if items.isEmpty { return "Выберите хотя бы одну услугу." }
        if items.count > Self.maxItems { return "Не больше \(Self.maxItems) услуг." }
        if let error = WaitlistRange.validate(from: dateFrom, to: dateTo, today: today, calendar: calendar) {
            return error.message
        }
        if note.trimmed.count > Self.maxNoteLength { return "Комментарий — не больше \(Self.maxNoteLength) символов." }
        return nil
    }

    /// The request, or `nil` while the draft is not valid.
    func body(today: Date = .now, calendar: Calendar = .app) -> WaitlistBody? {
        guard let client, validationMessage(today: today, calendar: calendar) == nil else { return nil }
        return WaitlistBody(
            clientId: client.id,
            items: items.map { WaitlistItemBody(serviceId: $0.serviceId, variant: $0.variant) },
            masterId: masterId,
            dateFrom: CalendarDay.string(from: dateFrom, calendar: calendar),
            dateTo: CalendarDay.string(from: dateTo, calendar: calendar),
            note: note.nonEmpty
        )
    }
}
