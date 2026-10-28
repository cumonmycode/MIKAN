import Foundation
import Testing
@testable import MIKAN

/// «После визита»: the bot asks how it heals and suggests a jewelry change (`Service.healingCheckDays` / `jewelryChangeWeeks`).
@MainActor
struct ServiceFollowUpTests {
    private func service(category: ServiceCategory = .piercing, healing: Int?, weeks: Int?) -> Service {
        Service(
            id: 8, name: "Хеликс", category: category, group: nil, price: 3_000, priceFrom: false, durationMin: 30,
            aftercareTemplateId: 2, healingCheckDays: healing, jewelryChangeWeeks: weeks, active: true, sort: 0
        )
    }

    @Test("A new service asks after a week; the jewelry change is off")
    func newService() {
        let draft = ServiceEditorDraft(service: nil, nextSort: 0)
        #expect(draft.followUps.asksHealing)
        #expect(draft.body.healingCheckDays == Nullable(7))
        #expect(draft.body.jewelryChangeWeeks == Nullable(nil))
    }

    @Test("Turning a switch on starts from 7 days / 6 weeks; the value is kept while it is off")
    func toggles() {
        var draft = ServiceFollowUpDraft(healingCheckDays: nil, jewelryChangeWeeks: nil)
        #expect(draft.healingCheckDays == nil && draft.jewelryChangeWeeks == nil)
        draft.asksHealing = true
        draft.remindsJewelryChange = true
        #expect(draft.healingCheckDays == 7)
        #expect(draft.jewelryChangeWeeks == 6)

        draft.healingDays = 10
        draft.asksHealing = false
        #expect(draft.healingCheckDays == nil)
        draft.asksHealing = true
        #expect(draft.healingCheckDays == 10)

        draft.healingDays = 99
        draft.jewelryWeeks = 0
        #expect(draft.healingCheckDays == 60, "clamped to what the server accepts")
        #expect(draft.jewelryChangeWeeks == 1)
    }

    @Test("The editor keeps the stored values and sends them; a PATCH body of the card carries them too")
    func roundTrip() {
        var draft = ServiceEditorDraft(service: service(healing: 14, weeks: 8), nextSort: 0)
        #expect(draft.followUps.healingDays == 14 && draft.followUps.jewelryWeeks == 8)
        #expect(draft.body.healingCheckDays == Nullable(14))
        #expect(draft.body.jewelryChangeWeeks == Nullable(8))
        draft.followUps.asksHealing = false
        #expect(draft.body.healingCheckDays == Nullable(nil), "sent as null: the check is turned off")

        let body = ServiceBody(service(healing: nil, weeks: 6))
        #expect(body.healingCheckDays == Nullable(nil))
        #expect(body.jewelryChangeWeeks == Nullable(6))
    }

    @Test("The jewelry change is offered for piercings; elsewhere only while it is on")
    func jewelryChangeVisibility() {
        let off = ServiceFollowUpDraft(healingCheckDays: 7, jewelryChangeWeeks: nil)
        #expect(off.showsJewelryChange(for: .piercing))
        #expect(!off.showsJewelryChange(for: .tattoo))
        #expect(!off.showsJewelryChange(for: .other))
        let on = ServiceFollowUpDraft(healingCheckDays: nil, jewelryChangeWeeks: 6)
        #expect(on.showsJewelryChange(for: .tattoo), "so it can be turned off after the category changed")
    }

    @Test("Texts of the editor and the card")
    func texts() {
        #expect(ServiceFollowUpText.healing(7) == "Через 7 дней")
        #expect(ServiceFollowUpText.healing(1) == "Через 1 день")
        #expect(ServiceFollowUpText.healing(nil) == "Нет")
        #expect(ServiceFollowUpText.jewelryChange(6) == "Через 6 недель")
        #expect(ServiceFollowUpText.jewelryChange(1) == "Через 1 неделю")
        #expect(ServiceFollowUpText.jewelryChange(3) == "Через 3 недели")
        #expect(ServiceFollowUpDraft(healingCheckDays: nil, jewelryChangeWeeks: nil).hint.contains("ничего не напишет"))
        #expect(ServiceFollowUpDraft(healingCheckDays: 7, jewelryChangeWeeks: 6).hint.contains("отзыв"))
    }

    @Test("A server without follow-ups reads as none; the fields decode when present")
    func decoding() throws {
        let legacy = try Fixtures.decode(Service.self, Fixtures.service)
        #expect(legacy.healingCheckDays == nil && legacy.jewelryChangeWeeks == nil)
        let json = Fixtures.service.replacingOccurrences(
            of: #""active": true"#, with: #""healingCheckDays": 7, "jewelryChangeWeeks": null, "active": true"#
        )
        let decoded = try Fixtures.decode(Service.self, json)
        #expect(decoded.healingCheckDays == 7)
        #expect(decoded.jewelryChangeWeeks == nil)
    }

    @Test("Queued follow-ups are labelled; an unknown kind does not break the list")
    func scheduledKinds() throws {
        let kinds = try JSONCoding.makeDecoder().decode(
            [ScheduledKind].self, from: Data(#"["aftercare", "reminder", "healing_check", "jewelry_change", "birthday"]"#.utf8)
        )
        #expect(kinds == [.aftercare, .reminder, .healingCheck, .jewelryChange, .other])
        #expect(kinds.map(\.title) == ["Уход", "Напоминание", "Вопрос о заживлении", "Замена украшения", "Сообщение"])
        let message = Fixtures.scheduledMessage.replacingOccurrences(of: #""kind": "aftercare""#, with: #""kind": "healing_check""#)
        #expect(try Fixtures.decode(ScheduledMessage.self, message).kind == .healingCheck)
    }
}
