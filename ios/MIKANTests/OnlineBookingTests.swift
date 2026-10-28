import Foundation
import Testing
@testable import MIKAN

/// Online booking (docs/API.md «Appointment», «StudioSettings», «Online booking»): the new fields decode with and
/// without a server that knows them, unsettled bookings are marked and acted on by role, settings are validated.
@MainActor
private enum OnlineSample {
    static let start = Date(timeIntervalSince1970: 1_792_062_000) // 2026-10-15 11:00 UTC
    static let hold = start.addingTimeInterval(-3600)

    static func appointment(
        id: Int = 1,
        masterId: Int = 2,
        status: AppointmentStatus = .scheduled,
        channel: AppointmentChannel = .web,
        state: OnlineBookingState? = .awaitingConfirmation,
        holdUntil: Date? = nil,
        startsAt: Date = start
    ) -> Appointment {
        Appointment(
            id: id, client: ClientRef(id: 1, name: "Анна", phone: "+79990000001", telegramLinked: false),
            master: EmployeeRef(id: masterId, name: "Фатима", color: nil), service: nil, title: "Мочка",
            startsAt: startsAt, endsAt: startsAt.addingTimeInterval(1800), status: status, price: 2500, deposit: 0,
            notes: nil, saleId: nil, completedAt: nil, createdAt: start, updatedAt: start,
            channel: channel, onlineState: state, holdUntil: holdUntil
        )
    }

    /// An appointment from docs/API.md without the online-booking fields; `extra` adds JSON members.
    static func json(extra: String = "") -> String {
        """
        { "id": 7, "client": { "id": 1, "name": "Анна", "phone": null, "telegramLinked": false },
          "master": { "id": 2, "name": "Фатима", "color": "#FF7A1A" }, "service": null, "title": null,
          "startsAt": "2026-10-21T12:00:00.000Z", "endsAt": "2026-10-21T12:30:00.000Z", "status": "scheduled",
          "price": 2500, "deposit": 0, "notes": null, "saleId": null, "completedAt": null,
          "createdAt": "2026-10-19T10:00:00.000Z", "updatedAt": "2026-10-19T10:00:00.000Z"\(extra) }
        """
    }
}

@MainActor
struct OnlineBookingDecodingTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.makeDecoder().decode(T.self, from: Data(json.utf8))
    }

    @Test("An online booking reads its channel, state and hold")
    func appointmentWithOnlineFields() throws {
        let json = OnlineSample.json(extra: #", "channel": "web", "onlineState": "awaiting_payment", "holdUntil": "2026-10-19T11:35:00.000Z""#)
        let appointment = try decode(Appointment.self, json)
        #expect(appointment.channel == .web)
        #expect(appointment.channel.isOnline)
        #expect(appointment.onlineState == .awaitingPayment)
        #expect(appointment.holdUntil == ISO8601.parse("2026-10-19T11:35:00.000Z"))
        #expect(appointment.isUnsettledOnline)
    }

    @Test("Every documented channel and state decodes", arguments: [
        ("app", AppointmentChannel.app), ("bot", .bot), ("miniapp", .miniapp), ("web", .web), ("kiosk", .other),
    ])
    func channels(raw: String, channel: AppointmentChannel) throws {
        let appointment = try decode(Appointment.self, OnlineSample.json(extra: #", "channel": "\#(raw)""#))
        #expect(appointment.channel == channel)
    }

    @Test("An older server, nulls and an unknown state read as a settled staff booking")
    func appointmentWithoutOnlineFields() throws {
        let legacy = try decode(Appointment.self, OnlineSample.json())
        #expect(legacy.channel == .app)
        #expect(legacy.onlineState == nil)
        #expect(legacy.holdUntil == nil)
        #expect(!legacy.isUnsettledOnline)

        let settled = try decode(Appointment.self, OnlineSample.json(extra: #", "channel": "bot", "onlineState": null, "holdUntil": null"#))
        #expect(settled.channel == .bot)
        #expect(settled.onlineState == nil)

        let newer = try decode(Appointment.self, OnlineSample.json(extra: #", "onlineState": "awaiting_review""#))
        #expect(newer.onlineState == nil, "a state this build does not know must not break the calendar")

        let docs = try Fixtures.decode(Appointment.self, Fixtures.appointmentWithDeposit)
        #expect(docs.channel == .app)
        #expect(docs.onlineState == nil)
    }

    @Test("Badges read onlineAwaiting; an older server gives 0")
    func badges() throws {
        let current = try decode(Badges.self, #"{ "unreadChats": 2, "needsAttention": 1, "newBookingRequests": 1, "lowStock": 3, "onlineAwaiting": 2 }"#)
        #expect(current.onlineAwaiting == 2)
        #expect(current.lowStock == 3)
        let legacy = try decode(Badges.self, Fixtures.badges)
        #expect(legacy.onlineAwaiting == 0)
        #expect(Badges.zero.onlineAwaiting == 0)
        let dashboard = try Fixtures.decode(Dashboard.self, Fixtures.dashboard)
        #expect(dashboard.badges.onlineAwaiting == 0)
    }

    @Test("Studio settings read onlineBooking and send it back; an older server leaves it out and gets nothing")
    func studioSettings() throws {
        let json = Fixtures.studioSettings.replacingOccurrences(
            of: #""workdayEnd": "21:00" }"#,
            with: #""workdayEnd": "21:00", "onlineBooking": { "enabled": false, "leadMinutes": 60, "horizonDays": 30, "holdMinutes": 20, "stepMinutes": 15, "note": "Возьмите паспорт" } }"#
        )
        let settings = try decode(StudioSettings.self, json)
        #expect(settings.onlineBooking == OnlineBookingSettings(
            enabled: false, leadMinutes: 60, horizonDays: 30, holdMinutes: 20, stepMinutes: 15, note: "Возьмите паспорт"
        ))
        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any]
        let online = try #require(sent?["onlineBooking"] as? [String: Any])
        #expect(online["leadMinutes"] as? Int == 60)
        #expect(online["note"] as? String == "Возьмите паспорт")

        let legacy = try decode(StudioSettings.self, Fixtures.studioSettings)
        #expect(legacy.onlineBooking == nil)
        let legacyBody = try JSONSerialization.jsonObject(with: JSONEncoder().encode(legacy)) as? [String: Any]
        #expect(legacyBody?.keys.contains("onlineBooking") == false)
    }

    @Test("Missing or null online booking fields take the documented defaults")
    func onlineBookingDefaults() throws {
        let partial = try decode(OnlineBookingSettings.self, #"{ "enabled": true, "note": null }"#)
        #expect(partial == OnlineBookingSettings())
        #expect(partial.leadMinutes == 120)
        #expect(partial.horizonDays == 60)
        #expect(partial.holdMinutes == 15)
        #expect(partial.stepMinutes == 30)
        #expect(partial.note.isEmpty)
    }

    @Test("A client's online booking in the audit log")
    func auditSource() throws {
        let json = #"{ "id": 1, "at": "<T>", "employee": null, "source": "online", "action": "appointment.create", "entity": "appointment", "entityId": 1, "summary": "s" }"#
        let entry = try Fixtures.decode(AuditEntry.self, json)
        #expect(entry.source == .online)
        #expect(AuditLogText.actor(of: entry) == "Клиент онлайн")
    }

    @Test("The reject body omits a blank reason and trims a given one")
    func rejectBody() throws {
        func sent(_ reason: String) throws -> [String: Any] {
            let data = try JSONCoding.makeEncoder().encode(OnlineRejectBody(reason: reason))
            return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        #expect(try sent("   ").isEmpty)
        #expect(try sent(" Мастер заболел \n")["reason"] as? String == "Мастер заболел")
    }
}

@MainActor
struct OnlineBookingPresentationTests {
    @Test("Unsettled bookings are marked; settled, cancelled and staff ones are not")
    func marks() {
        #expect(OnlineMark.of(OnlineSample.appointment()) == .awaitingConfirmation)
        #expect(OnlineMark.of(OnlineSample.appointment())?.text == "Ждёт подтверждения")

        let paying = OnlineSample.appointment(state: .awaitingPayment, holdUntil: OnlineSample.hold)
        #expect(OnlineMark.of(paying) == .awaitingPayment(until: OnlineSample.hold))
        #expect(OnlineMark.of(paying)?.text == "Ждёт оплату до \(DateText.time(OnlineSample.hold))")
        #expect(OnlineMark.awaitingPayment(until: nil).text == "Ждёт оплату")

        #expect(OnlineMark.of(OnlineSample.appointment(state: nil)) == nil)
        #expect(OnlineMark.of(OnlineSample.appointment(status: .cancelled)) == nil)
        #expect(OnlineMark.of(OnlineSample.appointment(channel: .app, state: nil)) == nil)
    }

    @Test("The card names the channel; a staff booking names none")
    func channelTexts() {
        #expect(AppointmentChannel.web.bookedText == "Записался онлайн: сайт")
        #expect(AppointmentChannel.miniapp.bookedText == "Записался онлайн: Mini App")
        #expect(AppointmentChannel.bot.bookedText == "Записался онлайн: бот")
        #expect(AppointmentChannel.app.bookedText == nil)
        #expect(!AppointmentChannel.app.isOnline)
    }

    @Test("Owner and admin act on any booking, a master on their own only")
    func actionsByRole() {
        let booking = OnlineSample.appointment(masterId: 2)
        for role in [EmployeeRole.owner, .admin] {
            #expect(OnlineBookingAction.available(for: booking, permissions: Permissions(role: role, employeeId: 9)) == [.confirm, .reject])
        }
        #expect(OnlineBookingAction.available(for: booking, permissions: Permissions(role: .master, employeeId: 2)) == [.confirm, .reject])
        #expect(OnlineBookingAction.available(for: booking, permissions: Permissions(role: .master, employeeId: 3)).isEmpty)
    }

    @Test("A booking waiting for payment can only be rejected; a settled one offers nothing")
    func actionsByState() {
        let owner = Permissions(role: .owner, employeeId: 1)
        let paying = OnlineSample.appointment(state: .awaitingPayment, holdUntil: OnlineSample.hold)
        #expect(OnlineBookingAction.available(for: paying, permissions: owner) == [.reject])
        #expect(OnlineBookingAction.available(for: OnlineSample.appointment(state: nil), permissions: owner).isEmpty)
        #expect(OnlineBookingAction.available(for: OnlineSample.appointment(status: .cancelled), permissions: owner).isEmpty)
    }

    @Test("The list shows bookings waiting for confirmation first, then for payment, each by start")
    func queueOrder() {
        let later = OnlineSample.start.addingTimeInterval(7200)
        let items = [
            OnlineSample.appointment(id: 1, state: .awaitingPayment, startsAt: OnlineSample.start),
            OnlineSample.appointment(id: 2, state: .awaitingConfirmation, startsAt: later),
            OnlineSample.appointment(id: 3, state: .awaitingConfirmation, startsAt: OnlineSample.start),
            OnlineSample.appointment(id: 4, state: nil),
            OnlineSample.appointment(id: 3, state: .awaitingConfirmation, startsAt: OnlineSample.start),
        ]
        #expect(OnlineBookingQueue.ordered(items).map(\.id) == [3, 2, 1])
        #expect(OnlineBookingQueue.items(items, in: .awaitingPayment).map(\.id) == [1])
    }

    @Test("A confirmed or rejected booking leaves the list; one still waiting is refreshed in place")
    func queueApplying() {
        let items = OnlineBookingQueue.ordered([
            OnlineSample.appointment(id: 1),
            OnlineSample.appointment(id: 2, state: .awaitingPayment),
        ])
        #expect(OnlineBookingQueue.applying(OnlineSample.appointment(id: 1, state: nil), to: items).map(\.id) == [2])
        #expect(OnlineBookingQueue.applying(OnlineSample.appointment(id: 2, status: .cancelled, state: nil), to: items).map(\.id) == [1])
        let moved = OnlineSample.appointment(id: 2, state: .awaitingConfirmation)
        #expect(OnlineBookingQueue.applying(moved, to: items).map(\.onlineState) == [.awaitingConfirmation, .awaitingConfirmation])
    }

    @Test("The booking link is the server origin plus /book")
    func bookingLink() throws {
        let production = try #require(URL(string: "https://95-170-124-192.sslip.io"))
        #expect(BookingLink.url(server: production).absoluteString == "https://95-170-124-192.sslip.io/book")
        let local = try #require(ServerConfig.normalize("http://localhost:3000/api/"))
        #expect(BookingLink.url(server: local).absoluteString == "http://localhost:3000/book")
    }
}

@MainActor
struct OnlineBookingSettingsTests {
    private func settings(
        lead: Int = 120, horizon: Int = 60, hold: Int = 15, step: Int = 30, note: String = ""
    ) -> OnlineBookingSettings {
        OnlineBookingSettings(enabled: true, leadMinutes: lead, horizonDays: horizon, holdMinutes: hold, stepMinutes: step, note: note)
    }

    @Test("The defaults and the limits themselves are valid")
    func valid() {
        #expect(OnlineBookingRules.issue(OnlineBookingSettings()) == nil)
        #expect(OnlineBookingRules.issue(settings(lead: 0, horizon: 1, hold: 5, step: 15)) == nil)
        #expect(OnlineBookingRules.issue(settings(lead: 2880, horizon: 180, hold: 60, step: 60)) == nil)
        #expect(OnlineBookingRules.issue(settings(note: String(repeating: "я", count: 500))) == nil)
    }

    @Test("Each value outside the server's limits blocks saving with its own message")
    func invalid() {
        #expect(OnlineBookingRules.issue(settings(lead: -1))?.contains("не позже чем за") == true)
        #expect(OnlineBookingRules.issue(settings(lead: 2881)) != nil)
        #expect(OnlineBookingRules.issue(settings(horizon: 0))?.contains("вперёд") == true)
        #expect(OnlineBookingRules.issue(settings(horizon: 181)) != nil)
        #expect(OnlineBookingRules.issue(settings(hold: 4))?.contains("оплату") == true)
        #expect(OnlineBookingRules.issue(settings(hold: 61)) != nil)
        #expect(OnlineBookingRules.issue(settings(step: 45))?.contains("Шаг") == true)
        #expect(OnlineBookingRules.issue(settings(note: String(repeating: "я", count: 501)))?.contains("500") == true)
        // 250 emoji are 500 UTF-16 units, as the server counts; one more is too long.
        #expect(OnlineBookingRules.issue(settings(note: String(repeating: "🙂", count: 250))) == nil)
        #expect(OnlineBookingRules.issue(settings(note: String(repeating: "🙂", count: 251))) != nil)
    }

    @Test("Pickers name the durations and keep a value set elsewhere")
    func options() {
        #expect(OnlineBookingOptions.leadTitle(0) == "Без ограничения")
        #expect(OnlineBookingOptions.leadTitle(30) == "30 мин")
        #expect(OnlineBookingOptions.leadTitle(120) == "2 ч")
        #expect(OnlineBookingOptions.leadTitle(90) == "1 ч 30 мин")
        #expect(OnlineBookingOptions.leadTitle(1440) == "1 день")
        #expect(OnlineBookingOptions.leadTitle(2880) == "2 дня")
        #expect(OnlineBookingOptions.horizonTitle(60) == "60 дней")
        #expect(OnlineBookingOptions.leads(including: 100).contains(100))
        #expect(OnlineBookingOptions.leads(including: 100) == OnlineBookingOptions.leads(including: 100).sorted())
        #expect(OnlineBookingOptions.holds(including: 15) == OnlineBookingOptions.holdChoices)
        #expect(OnlineBookingOptions.stepChoices == [15, 30, 60])
    }

    @Test("The footer explains the rules, or that online booking is off")
    func footer() {
        #expect(OnlineBookingOptions.footer(OnlineBookingSettings()).contains("не позже чем за 2 ч"))
        var off = OnlineBookingSettings()
        off.enabled = false
        #expect(OnlineBookingOptions.footer(off).contains("выключена"))
    }
}
