import Foundation
import Testing
@testable import MIKAN

@MainActor
private enum RulesSample {
    static let start = Date(timeIntervalSince1970: 1_792_062_000) // 2026-10-15 11:00 UTC
    static let freeUntil = start.addingTimeInterval(-24 * 3600)

    static func rules(freeUntil: Date? = freeUntil, late: Int = 2000, noShow: Int = 2000) -> AppointmentCancellation {
        AppointmentCancellation(freeUntil: freeUntil, lateRetain: late, noShowRetain: noShow)
    }

    static func appointment(
        status: AppointmentStatus = .scheduled,
        held: Int = 2000,
        operations: [DepositOperation]? = nil,
        cancellation: AppointmentCancellation? = rules()
    ) -> Appointment {
        Appointment(
            id: 4, client: ClientRef(id: 1, name: "Иван Петров", phone: nil, telegramLinked: true),
            master: EmployeeRef(id: 2, name: "Анна", color: nil), service: nil, title: nil,
            startsAt: start, endsAt: start.addingTimeInterval(3600), status: status, price: 8000, deposit: held,
            depositRequired: 2000, depositStatus: held > 0 ? .paid : .waiting,
            depositOperations: operations ?? (held > 0 ? [operation(id: 1, .receive, amount: held)] : []),
            depositLink: nil, notes: nil, saleId: nil, completedAt: nil, createdAt: start, updatedAt: start,
            cancellation: cancellation
        )
    }

    static func operation(id: Int, _ type: DepositOperationType, amount: Int) -> DepositOperation {
        DepositOperation(
            id: id, appointmentId: 4, type: type, amount: amount, method: type == .receive ? .transfer : nil, saleId: nil,
            shiftId: nil, qrPaymentId: nil, note: nil, employee: nil, createdAt: start
        )
    }

    static let early = freeUntil.addingTimeInterval(-3600)
    static let late = freeUntil.addingTimeInterval(3600)
}

@MainActor
struct CancellationDecodingTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.makeDecoder().decode(T.self, from: Data(json.utf8))
    }

    @Test("Studio settings read the rules and review links; an older server leaves them out and gets nothing back")
    func studioSettings() throws {
        let json = """
        { "name": "MIKAN STUDIO", "address": "", "phone": "", "workingHours": "", "instagram": "", "website": "",
          "about": "", "timezone": "Europe/Moscow", "workdayStart": "10:00", "workdayEnd": "21:00",
          "cancellation": { "freeHours": 48, "lateRetainPercent": 50, "noShowRetainPercent": 100, "autoRetain": true },
          "reviewLinks": { "yandex": "https://yandex.ru/maps/org/1", "twogis": "", "google": "" } }
        """
        let settings = try decode(StudioSettings.self, json)
        #expect(settings.cancellation == CancellationRules(freeHours: 48, lateRetainPercent: 50, noShowRetainPercent: 100, autoRetain: true))
        #expect(settings.reviewLinks?.yandex == "https://yandex.ru/maps/org/1")
        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any]
        #expect(sent?["cancellation"] != nil)
        #expect(sent?["reviewLinks"] != nil)

        let legacy = try decode(StudioSettings.self, Fixtures.studioSettings)
        #expect(legacy.cancellation == nil)
        #expect(legacy.reviewLinks == nil)
        let legacyBody = try JSONSerialization.jsonObject(with: JSONEncoder().encode(legacy)) as? [String: Any]
        #expect(legacyBody?.keys.contains("cancellation") == false)
        #expect(legacyBody?.keys.contains("reviewLinks") == false)
    }

    @Test("An appointment reads what the rules mean for it; null and older servers give nil")
    func appointment() throws {
        let base = """
        "id": 4, "client": { "id": 1, "name": "Иван", "phone": null, "telegramLinked": false },
        "master": { "id": 2, "name": "Анна", "color": "#FF7A1A" }, "service": null, "title": null,
        "startsAt": "2026-10-17T11:00:00.000Z", "endsAt": "2026-10-17T12:00:00.000Z", "status": "scheduled",
        "price": 8000, "deposit": 2000, "notes": null, "saleId": null, "completedAt": null,
        "createdAt": "2026-10-15T10:00:00.000Z", "updatedAt": "2026-10-15T10:00:00.000Z"
        """
        let withRules = try decode(Appointment.self, "{ \(base), \"cancellation\": { \"freeUntil\": \"2026-10-16T11:00:00.000Z\", \"lateRetain\": 2000, \"noShowRetain\": 1000 } }")
        #expect(withRules.cancellation == AppointmentCancellation(
            freeUntil: Date(timeIntervalSince1970: 1_792_148_400), lateRetain: 2000, noShowRetain: 1000
        ))
        let neverFree = try decode(Appointment.self, "{ \(base), \"cancellation\": { \"freeUntil\": null, \"lateRetain\": 2000, \"noShowRetain\": 2000 } }")
        #expect(neverFree.cancellation?.freeUntil == nil)
        #expect(try decode(Appointment.self, "{ \(base), \"cancellation\": null }").cancellation == nil)
        #expect(try decode(Appointment.self, "{ \(base) }").cancellation == nil)
    }
}

@MainActor
struct CancellationCardTests {
    @Test("The prepayment block says until when a free cancellation is possible")
    func freeUntilLine() {
        let appointment = RulesSample.appointment()
        #expect(DepositRules.freeUntilLine(appointment, now: RulesSample.early) == "Бесплатная отмена до \(DateText.dateTime(RulesSample.freeUntil))")
        #expect(DepositRules.freeUntilLine(appointment, now: RulesSample.freeUntil) == "Бесплатная отмена до \(DateText.dateTime(RulesSample.freeUntil))")
        #expect(DepositRules.freeUntilLine(appointment, now: RulesSample.late) == "Бесплатная отмена уже недоступна")
        #expect(DepositRules.freeUntilLine(RulesSample.appointment(cancellation: RulesSample.rules(freeUntil: nil)), now: RulesSample.early)
            == "Бесплатная отмена не предусмотрена")
        #expect(DepositRules.freeUntilLine(RulesSample.appointment(status: .cancelled), now: RulesSample.early) == nil)
        #expect(DepositRules.freeUntilLine(RulesSample.appointment(cancellation: nil), now: RulesSample.early) == nil)
    }

    @Test("The cancel and no-show confirmations say what the rules keep")
    func closingNotes() {
        let full = RulesSample.appointment()
        #expect(DepositRules.closingNote(full, becoming: .cancelled, at: RulesSample.late)
            == "По правилам студии удерживается \(Money.format(2000)) из \(Money.format(2000)).")
        #expect(DepositRules.closingNote(full, becoming: .cancelled, at: RulesSample.early)
            == "Отмена бесплатная — предоплату \(Money.format(2000)) можно вернуть клиенту.")
        let half = RulesSample.appointment(cancellation: RulesSample.rules(late: 1000, noShow: 2000))
        #expect(DepositRules.closingNote(half, becoming: .cancelled, at: RulesSample.late)
            == "По правилам студии удерживается \(Money.format(1000)) из \(Money.format(2000)), остальное возвращается клиенту.")
        #expect(DepositRules.closingNote(half, becoming: .noShow, at: RulesSample.early)
            == "По правилам студии удерживается \(Money.format(2000)) из \(Money.format(2000)).")
        let none = RulesSample.appointment(cancellation: RulesSample.rules(late: 0))
        #expect(DepositRules.closingNote(none, becoming: .cancelled, at: RulesSample.late)
            == "По правилам студии предоплата \(Money.format(2000)) возвращается клиенту.")
        #expect(DepositRules.closingNote(RulesSample.appointment(held: 0), becoming: .cancelled, at: RulesSample.late) == nil)
        #expect(DepositRules.closingNote(RulesSample.appointment(cancellation: nil), becoming: .noShow, at: RulesSample.late) == nil)
    }

    @Test("The card's «Удержать» opens with the rules' share; after an earlier retain, with the remainder")
    func retainPrefill() {
        let late = RulesSample.rules(late: 1000, noShow: 1500)
        #expect(DepositRules.retainPrefill(RulesSample.appointment(status: .cancelled, cancellation: late)) == 1000)
        #expect(DepositRules.retainPrefill(RulesSample.appointment(status: .noShow, cancellation: late)) == 1500)
        #expect(DepositRules.retainPrefill(RulesSample.appointment(status: .cancelled, cancellation: RulesSample.rules(late: 0))) == 2000)
        #expect(DepositRules.retainPrefill(RulesSample.appointment(status: .cancelled, cancellation: nil)) == 2000)
        let remainder = RulesSample.appointment(
            status: .cancelled, held: 1000,
            operations: [RulesSample.operation(id: 1, .receive, amount: 2000), RulesSample.operation(id: 2, .retain, amount: 1000)],
            cancellation: RulesSample.rules(late: 500, noShow: 1000)
        )
        #expect(DepositRules.retainPrefill(remainder) == 1000)
    }

    @Test("A retain is noted the way the server notes it")
    func retainReason() {
        #expect(DepositRules.retainReason(RulesSample.appointment(status: .cancelled)) == "Поздняя отмена — меньше 24 ч до записи")
        #expect(DepositRules.retainReason(RulesSample.appointment(status: .noShow)) == "Неявка")
        #expect(DepositRules.retainReason(RulesSample.appointment(status: .cancelled, cancellation: nil)) == "Отмена записи")
        #expect(DepositRules.retainReason(RulesSample.appointment(status: .cancelled, cancellation: RulesSample.rules(freeUntil: nil)))
            == "Отмена записи — по правилам студии")
    }
}

@MainActor
struct DepositDecisionTests {
    @Test("A late cancellation suggests retaining the rules' share first")
    func lateCancellation() {
        let before = RulesSample.appointment(cancellation: RulesSample.rules(late: 1000))
        let after = RulesSample.appointment(status: .cancelled, cancellation: RulesSample.rules(late: 1000))
        let decision = DepositDecision(before: before, after: after, at: RulesSample.late)
        #expect(decision.autoRetained == 0)
        #expect(decision.rulesRetain == 1000)
        #expect(decision.suggestsRetain)
        #expect(decision.retainPrefill == 1000)
        #expect(decision.message.hasPrefix("По правилам студии удерживается \(Money.format(1000)) из \(Money.format(2000))"))
    }

    @Test("A free cancellation suggests a refund; retaining then opens with everything held")
    func freeCancellation() {
        let decision = DepositDecision(
            before: RulesSample.appointment(), after: RulesSample.appointment(status: .cancelled), at: RulesSample.early
        )
        #expect(decision.rulesRetain == 0)
        #expect(decision.isFree)
        #expect(!decision.suggestsRetain)
        #expect(decision.retainPrefill == 2000)
        #expect(decision.message.hasPrefix("Отмена бесплатная"))
    }

    @Test("After the server retained by itself only the remainder is left to refund")
    func automaticRetain() {
        let before = RulesSample.appointment(cancellation: RulesSample.rules(noShow: 1000))
        let after = RulesSample.appointment(
            status: .noShow, held: 1000,
            operations: [RulesSample.operation(id: 1, .receive, amount: 2000), RulesSample.operation(id: 2, .retain, amount: 1000)],
            cancellation: RulesSample.rules(late: 1000, noShow: 500)
        )
        let decision = DepositDecision(before: before, after: after, at: RulesSample.late)
        #expect(decision.autoRetained == 1000)
        #expect(decision.held == 1000)
        #expect(!decision.suggestsRetain)
        #expect(decision.message == "По правилам студии удержано \(Money.format(1000)). Остаток \(Money.format(1000)) можно вернуть клиенту — сейчас или позже в карточке записи.")
    }

    @Test("Without rules (an older server) the question stays as it was")
    func withoutRules() {
        let decision = DepositDecision(
            before: RulesSample.appointment(cancellation: nil), after: RulesSample.appointment(status: .cancelled, cancellation: nil),
            at: RulesSample.late
        )
        #expect(decision.rulesRetain == nil)
        #expect(decision.retainPrefill == 2000)
        #expect(decision.message == DepositDecision.fallbackMessage)
    }

    @Test("The retain sheet checks the amount and tells what stays held")
    func retainSheetRules() {
        #expect(DepositRetainRules.amountMessage(0, held: 2000) != nil)
        #expect(DepositRetainRules.amountMessage(2500, held: 2000) != nil)
        #expect(DepositRetainRules.amountMessage(1000, held: 2000) == nil)
        #expect(DepositRetainRules.footer(amount: 1000, held: 2000).contains("Остаток \(Money.format(1000))"))
        #expect(!DepositRetainRules.footer(amount: 2000, held: 2000).contains("Остаток"))
    }
}

@MainActor
struct StudioPolicySettingsTests {
    @Test("Free-cancellation choices include «Не предусмотрена» and a value set elsewhere")
    func freeHoursChoices() {
        #expect(CancellationRulesOptions.freeHoursTitle(0) == "Не предусмотрена")
        #expect(CancellationRulesOptions.freeHoursTitle(24) == "за 24 ч")
        #expect(CancellationRulesOptions.freeHours(including: 24) == CancellationRulesOptions.freeHourChoices)
        let custom = CancellationRulesOptions.freeHours(including: 30)
        #expect(custom.contains(30))
        #expect(custom == custom.sorted())
        #expect(CancellationRulesOptions.percents(including: 33).contains(33))
        #expect(CancellationRulesOptions.lateRetainTitle(freeHours: 0) == "Удерживать при отмене")
    }

    @Test("The footer explains the automatic retain")
    func footer() {
        let manual = CancellationRules(freeHours: 24, lateRetainPercent: 100, noShowRetainPercent: 100, autoRetain: false)
        var automatic = manual
        automatic.autoRetain = true
        #expect(CancellationRulesOptions.footer(manual).contains("решаете вы"))
        #expect(CancellationRulesOptions.footer(automatic).contains("удержание запишется само"))
    }

    @Test("Review links are https or empty, at most 500 characters")
    func reviewLinks() {
        var links = ReviewLinks(yandex: "https://yandex.ru/maps/org/mikan/1/reviews/", twogis: "", google: " https://g.page/r/abc ")
        #expect(ReviewLinksRules.issue(links) == nil)
        links.twogis = "http://2gis.ru/tomsk/firm/1"
        #expect(ReviewLinksRules.issue(links) == "Ссылка «2ГИС» должна начинаться с https://")
        links.twogis = "2gis.ru"
        #expect(ReviewLinksRules.issue(links) != nil)
        links.twogis = "https://2gis.ru/" + String(repeating: "a", count: 500)
        #expect(ReviewLinksRules.issue(links) == "Ссылка «2ГИС» слишком длинная.")
    }
}
