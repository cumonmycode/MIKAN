import Foundation
import Testing
@testable import MIKAN

/// Waitlist (docs/API.md «Waitlist»): entries decode, the list groups them by status, the dates are checked before
/// sending and read in Russian.
@MainActor
private enum WaitlistSample {
    static let calendar: Calendar = {
        var calendar = Calendar.app
        calendar.timeZone = TimeZone(identifier: "Asia/Tomsk") ?? .gmt
        return calendar
    }()

    /// 20 October 2026, 14:00 in the studio.
    static let now = day(2026, 10, 20, hour: 14)

    static func day(_ year: Int, _ month: Int, _ day: Int, hour: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour)) ?? .distantPast
    }

    static func entry(
        id: Int,
        status: WaitlistStatus = .waiting,
        createdAt: Date = now,
        master: EmployeeRef? = nil
    ) -> WaitlistEntry {
        WaitlistEntry(
            id: id,
            client: ClientRef(id: 1, name: "Анна", lastName: "Иванова", phone: "+79990000001", telegramLinked: true),
            items: [WaitlistItem(serviceId: 3, variant: "Два", name: "Мочка")],
            master: master,
            dateFrom: "2026-10-21",
            dateTo: "2026-10-25",
            status: status,
            channel: .app,
            notifiedAt: nil,
            appointmentId: nil,
            note: nil,
            createdAt: createdAt
        )
    }

    static let service = Service(
        id: 3, name: "Мочка", category: .piercing, group: "Ухо", price: 2500, priceMax: nil, priceFrom: false,
        durationMin: 30, description: nil, imageUrl: nil, imagePrompt: nil,
        variants: [ServiceVariant(name: "Один", price: 2500), ServiceVariant(name: "Два", price: 4000)],
        aftercareTemplateId: nil, active: true, sort: 0
    )

    static func plainService(id: Int) -> Service {
        Service(
            id: id, name: "Услуга \(id)", category: .piercing, group: nil, price: 1000, priceMax: nil, priceFrom: false,
            durationMin: 30, description: nil, imageUrl: nil, imagePrompt: nil, aftercareTemplateId: nil, active: true, sort: id
        )
    }
}

@MainActor
struct WaitlistDecodingTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.makeDecoder().decode(T.self, from: Data(json.utf8))
    }

    @Test("An entry from docs/API.md decodes: any master, a variant, the channel and the notice time")
    func entry() throws {
        let json = """
        { "id": 4, "client": { "id": 1, "name": "Анна", "lastName": "Иванова", "phone": "+79990000001", "telegramLinked": true },
          "items": [ { "serviceId": 3, "variant": "Два", "name": "Мочка" }, { "serviceId": 5, "variant": null, "name": "Хеликс" } ],
          "master": null, "dateFrom": "2026-10-21", "dateTo": "2026-10-25", "status": "notified", "channel": "miniapp",
          "notifiedAt": "2026-10-20T08:00:00.000Z", "appointmentId": null, "note": "После обеда",
          "createdAt": "2026-10-19T10:00:00.000Z" }
        """
        let entry = try decode(WaitlistEntry.self, json)
        #expect(entry.client.fullName == "Анна Иванова")
        #expect(entry.master == nil)
        #expect(entry.status == .notified)
        #expect(entry.status.isOpen)
        #expect(entry.channel == .miniapp)
        #expect(entry.notifiedAt == ISO8601.parse("2026-10-20T08:00:00.000Z"))
        #expect(WaitlistText.services(entry.items) == "Мочка — Два, Хеликс")
    }

    @Test("Badges read waitlist; an older server gives 0")
    func badges() throws {
        let current = try decode(Badges.self, #"{ "unreadChats": 0, "needsAttention": 0, "newBookingRequests": 0, "lowStock": 0, "onlineAwaiting": 1, "waitlist": 4 }"#)
        #expect(current.waitlist == 4)
        #expect(try decode(Badges.self, Fixtures.badges).waitlist == 0)
        #expect(Badges.zero.waitlist == 0)
    }

    @Test("Only waiting and notified entries are open", arguments: WaitlistStatus.allCases)
    func openStatuses(status: WaitlistStatus) {
        #expect(status.isOpen == [.waiting, .notified].contains(status))
    }
}

@MainActor
struct WaitlistGroupingTests {
    @Test("Sections follow the status order and skip empty ones")
    func sectionOrder() {
        let entries = [
            WaitlistSample.entry(id: 1, status: .expired),
            WaitlistSample.entry(id: 2, status: .booked),
            WaitlistSample.entry(id: 3, status: .waiting),
            WaitlistSample.entry(id: 4, status: .notified),
        ]
        let sections = WaitlistGrouping.sections(entries)
        #expect(sections.map(\.status) == [.waiting, .notified, .booked, .expired], "no «Отменены» without cancelled entries")
        #expect(sections.map { WaitlistGrouping.title($0.status) } == ["Ждут", "Сообщили о времени", "Записались", "Истекли"])
        #expect(WaitlistGrouping.sections([]).isEmpty)
    }

    @Test("Inside a section the oldest entry comes first; an id appears once")
    func oldestFirst() {
        let base = WaitlistSample.now
        let entries = [
            WaitlistSample.entry(id: 5, createdAt: base.addingTimeInterval(120)),
            WaitlistSample.entry(id: 7, createdAt: base),
            WaitlistSample.entry(id: 6, createdAt: base),
            WaitlistSample.entry(id: 9, createdAt: base.addingTimeInterval(-60)),
            WaitlistSample.entry(id: 9, createdAt: base.addingTimeInterval(-60)),
        ]
        let sections = WaitlistGrouping.sections(entries)
        #expect(sections.count == 1)
        #expect(sections.first?.entries.map(\.id) == [9, 6, 7, 5])
    }

    @Test("A cancelled entry moves to «Отменены»; a new one joins its section")
    func applying() {
        let entries = [WaitlistSample.entry(id: 1), WaitlistSample.entry(id: 2)]
        let cancelled = WaitlistGrouping.applying(WaitlistSample.entry(id: 1, status: .cancelled), to: entries)
        let sections = WaitlistGrouping.sections(cancelled)
        #expect(sections.map(\.status) == [.waiting, .cancelled])
        #expect(sections.first?.entries.map(\.id) == [2])

        let added = WaitlistGrouping.applying(WaitlistSample.entry(id: 3), to: entries)
        #expect(added.map(\.id) == [1, 2, 3])
    }
}

@MainActor
struct WaitlistRangeTests {
    private func check(_ from: Date, _ to: Date) -> WaitlistRangeError? {
        WaitlistRange.validate(from: from, to: to, today: WaitlistSample.now, calendar: WaitlistSample.calendar)
    }

    @Test("Today through two weeks is fine; a single day too")
    func valid() {
        #expect(check(WaitlistSample.day(2026, 10, 20), WaitlistSample.day(2026, 11, 2)) == nil)
        #expect(check(WaitlistSample.day(2026, 10, 21, hour: 18), WaitlistSample.day(2026, 10, 21, hour: 9)) == nil)
    }

    @Test("A start before today is refused")
    func startInPast() {
        #expect(check(WaitlistSample.day(2026, 10, 19, hour: 23), WaitlistSample.day(2026, 10, 25)) == .startInPast)
    }

    @Test("An end before the start is refused")
    func endBeforeStart() {
        #expect(check(WaitlistSample.day(2026, 10, 25), WaitlistSample.day(2026, 10, 24)) == .endBeforeStart)
    }

    @Test("30 days inclusive pass, 31 do not")
    func thirtyDays() {
        let from = WaitlistSample.day(2026, 10, 20)
        #expect(WaitlistRange.days(from: from, to: WaitlistSample.day(2026, 11, 18), calendar: WaitlistSample.calendar) == 30)
        #expect(check(from, WaitlistSample.day(2026, 11, 18)) == nil)
        #expect(check(from, WaitlistSample.day(2026, 11, 19)) == .tooLong)
        #expect(WaitlistRangeError.tooLong.message == "Период — не больше 30 дней.")
    }

    @Test("Staff may wait up to a year ahead")
    func yearAhead() {
        #expect(check(WaitlistSample.day(2027, 10, 1), WaitlistSample.day(2027, 10, 20)) == nil)
        #expect(check(WaitlistSample.day(2027, 10, 15), WaitlistSample.day(2027, 10, 21)) == .tooFar)
    }
}

@MainActor
struct WaitlistTextTests {
    private func range(_ from: String, _ to: String) -> String {
        WaitlistText.range(from: from, to: to, now: WaitlistSample.now, calendar: WaitlistSample.calendar)
    }

    @Test("Ranges read in Russian")
    func ranges() {
        #expect(range("2026-10-21", "2026-10-21") == "21 октября")
        #expect(range("2026-10-21", "2026-10-25") == "21–25 октября")
        #expect(range("2026-10-30", "2026-11-03") == "30 октября – 3 ноября")
    }

    @Test("The year shows only outside the current one")
    func years() {
        let across = range("2026-12-28", "2027-01-03")
        #expect(across.hasPrefix("28 декабря 2026"), "\(across)")
        #expect(across.contains(" – 3 января 2027"), "\(across)")
        let nextYear = range("2027-01-05", "2027-01-09")
        #expect(nextYear.hasPrefix("5–9 января 2027"), "\(nextYear)")
    }

    @Test("Unparsable dates are shown as they came")
    func unparsable() {
        #expect(range("soon", "later") == "soon – later")
    }

    @Test("Services, master and channel labels")
    func labels() {
        #expect(WaitlistItem(serviceId: 1, variant: "Два", name: "Мочка").title == "Мочка — Два")
        #expect(WaitlistItem(serviceId: 1, variant: nil, name: "Хеликс").title == "Хеликс")
        #expect(WaitlistText.master(nil) == "Любой мастер")
        #expect(WaitlistText.master(EmployeeRef(id: 2, name: "Фатима", color: nil)) == "Фатима")
        #expect([AppointmentChannel.app, .bot, .miniapp, .web].map(WaitlistText.channel) == ["Приложение", "Бот", "Mini App", "Сайт"])
    }
}

@MainActor
struct WaitlistDraftTests {
    private let calendar = WaitlistSample.calendar
    private let today = WaitlistSample.now

    @Test("A new draft waits the next two weeks from today")
    func defaults() {
        let draft = WaitlistDraft(today: today, calendar: calendar)
        #expect(draft.dateFrom == WaitlistSample.day(2026, 10, 20))
        #expect(draft.dateTo == WaitlistSample.day(2026, 11, 2))
        #expect(draft.validationMessage(today: today, calendar: calendar) == "Выберите клиента.")
    }

    @Test("A client and at least one service are required")
    func requiredFields() {
        var draft = WaitlistDraft(today: today, calendar: calendar)
        draft.client = WaitlistSample.entry(id: 1).client
        #expect(draft.validationMessage(today: today, calendar: calendar) == "Выберите хотя бы одну услугу.")
        #expect(draft.body(today: today, calendar: calendar) == nil)
        draft.toggle(service: WaitlistSample.plainService(id: 10))
        #expect(draft.validationMessage(today: today, calendar: calendar) == nil)
    }

    @Test("At most five services; a variant replaces the service's choice in place")
    func items() {
        var draft = WaitlistDraft(today: today, calendar: calendar)
        draft.select(service: WaitlistSample.service, variant: WaitlistSample.service.variants[0])
        draft.select(service: WaitlistSample.service, variant: WaitlistSample.service.variants[1])
        #expect(draft.items.map(\.title) == ["Мочка — Два"])
        for id in 10..<16 { draft.toggle(service: WaitlistSample.plainService(id: id)) }
        #expect(draft.items.count == WaitlistDraft.maxItems)
        #expect(!draft.canAddItem)
        draft.toggle(service: WaitlistSample.plainService(id: 10))
        #expect(draft.items.count == 4)
    }

    @Test("Moving the start past the end pulls the end along")
    func startPullsEnd() {
        var draft = WaitlistDraft(today: today, calendar: calendar)
        draft.dateFrom = WaitlistSample.day(2026, 11, 10)
        #expect(draft.dateTo == WaitlistSample.day(2026, 11, 10))
    }

    @Test("The body sends dates as days, omits any master and a blank note")
    func body() throws {
        var draft = WaitlistDraft(client: WaitlistSample.entry(id: 1).client, today: today, calendar: calendar)
        draft.select(service: WaitlistSample.service, variant: WaitlistSample.service.variants[1])
        draft.toggle(service: WaitlistSample.plainService(id: 10))
        draft.note = "   "
        let body = try #require(draft.body(today: today, calendar: calendar))
        #expect(body == WaitlistBody(
            clientId: 1,
            items: [WaitlistItemBody(serviceId: 3, variant: "Два"), WaitlistItemBody(serviceId: 10, variant: nil)],
            masterId: nil, dateFrom: "2026-10-20", dateTo: "2026-11-02", note: nil
        ))
        let json = try #require(
            try JSONSerialization.jsonObject(with: JSONCoding.makeEncoder().encode(body)) as? [String: Any]
        )
        #expect(json["masterId"] == nil)
        #expect(json["note"] == nil)
        #expect(json["dateFrom"] as? String == "2026-10-20")
    }

    @Test("A note over 500 characters is refused")
    func longNote() {
        var draft = WaitlistDraft(client: WaitlistSample.entry(id: 1).client, today: today, calendar: calendar)
        draft.toggle(service: WaitlistSample.plainService(id: 10))
        draft.note = String(repeating: "а", count: 501)
        #expect(draft.validationMessage(today: today, calendar: calendar) == "Комментарий — не больше 500 символов.")
    }
}
