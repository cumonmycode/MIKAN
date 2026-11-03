import Foundation
import Testing
@testable import MIKAN

/// «Похожие карточки» and merging cards (docs/API.md «Clients» → «Duplicates», «Merge»).
struct ClientDuplicatesTests {
    private func card(
        _ id: Int,
        _ name: String,
        lastName: String? = nil,
        phone: String? = nil,
        instagram: String? = nil,
        telegramNick: String? = nil,
        birthday: String? = nil,
        notes: String? = nil,
        source: String? = nil,
        linked: Bool = false,
        username: String? = nil,
        stats: ClientStats? = nil
    ) -> Client {
        Client(
            id: id, name: name, lastName: lastName, phone: phone, instagram: instagram, telegramNick: telegramNick,
            birthday: birthday, notes: notes, source: source, telegramLinked: linked, telegramUsername: username,
            botEnabled: true, archived: false, createdAt: Fixtures.referenceDate, updatedAt: Fixtures.referenceDate,
            stats: stats
        )
    }

    private func stats(visits: Int, spent: Int, upcoming: Int = 0, last: Date? = nil) -> ClientStats {
        ClientStats(visits: visits, totalSpent: spent, lastVisitAt: last, upcomingAppointments: upcoming)
    }

    // MARK: - The list

    @Test("A group decodes with its reason and cards; an unknown reason does not break the list")
    func decoding() throws {
        let second = Fixtures.clientInList.replacingOccurrences(of: #""id": 1"#, with: #""id": 2"#)
        let json = """
        { "items": [
          { "reason": "same_full_name", "clients": [\(Fixtures.clientInList), \(second)] },
          { "reason": "same_vk", "clients": [] }
        ] }
        """
        let response = try Fixtures.decode(ItemsResponse<DuplicateGroup>.self, json)
        #expect(response.items.map(\.reason) == [.sameFullName, .other])
        #expect(response.items[0].clientIds == [1, 2])
        #expect(response.items[0].id == "same_full_name:1,2")
        #expect(DuplicateReason.phonelessSameName.title == "То же имя, у карточки нет телефона")
    }

    @Test("Merging and dismissing send the ids the server expects")
    func bodies() throws {
        let encoder = JSONCoding.makeEncoder()
        let merge = try #require(JSONSerialization.jsonObject(with: encoder.encode(ClientMergeBody(intoId: 7))) as? [String: Any])
        #expect(merge["intoId"] as? Int == 7)
        let dismiss = try #require(
            JSONSerialization.jsonObject(with: encoder.encode(DuplicateDismissBody(clientIds: [3, 4]))) as? [String: Any]
        )
        #expect(dismiss["clientIds"] as? [Int] == [3, 4])
    }

    @Test("Only the owner and the admin see and merge duplicates")
    func permissions() {
        #expect(Permissions(role: .owner, employeeId: 1).mergesClients)
        #expect(Permissions(role: .admin, employeeId: 2).mergesClients)
        #expect(!Permissions(role: .master, employeeId: 3).mergesClients)
    }

    // MARK: - Side by side

    @Test("Cards line up row by row: name, phone, visits, spent, last visit, Telegram")
    func comparisonRows() {
        let last = Fixtures.referenceDate
        let anna = card(1, "Анна", lastName: "Иванова", phone: "+79990000001", linked: true, username: "anna_tg", stats: stats(visits: 3, spent: 5_500, last: last))
        let other = card(2, "Анна", lastName: "Иванова", telegramNick: "anna_nick", stats: stats(visits: 0, spent: 0))

        let rows = DuplicateComparison.rows([anna, other])
        #expect(rows.map(\.title) == ["Имя", "Телефон", "Визиты", "Потрачено", "Последний визит", "Telegram"])
        #expect(rows[0].values == ["Анна Иванова", "Анна Иванова"])
        #expect(rows[1].values == ["+7 999 000-00-01", nil])
        #expect(rows[2].values == ["3", "0"])
        #expect(rows[3].values == [Money.format(5_500), Money.format(0)])
        #expect(rows[4].values == [DateText.fullDate(last), nil])
        #expect(rows[5].values == ["@anna_tg · бот", "@anna_nick"])
    }

    @Test("Only who the person is counts as a conflict; an empty value never does")
    func conflicts() {
        let rows = DuplicateComparison.rows([
            card(1, "Анна", phone: "+79990000001", instagram: "anna.one", stats: stats(visits: 3, spent: 100)),
            card(2, "Анна", phone: "+79990000002", stats: stats(visits: 1, spent: 900)),
        ])
        let byTitle = Dictionary(uniqueKeysWithValues: rows.map { ($0.title, $0) })
        #expect(byTitle["Телефон"]?.conflicts == true)
        #expect(byTitle["Имя"]?.conflicts == false)
        #expect(byTitle["Визиты"]?.conflicts == false, "different histories are expected")
        #expect(byTitle["Instagram"]?.conflicts == false, "one card has none")
        #expect(byTitle["Дата рождения"] == nil, "no card has a birthday")
    }

    @Test("The same name or handle written differently is no conflict")
    func normalisedConflicts() {
        let rows = DuplicateComparison.rows([
            card(1, "Алёна", lastName: "Петрова", telegramNick: "Kate_Tattoo"),
            card(2, "алена  петрова", linked: true, username: "kate_tattoo"),
        ])
        let byTitle = Dictionary(uniqueKeysWithValues: rows.map { ($0.title, $0) })
        #expect(byTitle["Имя"]?.conflicts == false)
        #expect(byTitle["Telegram"]?.values == ["@Kate_Tattoo", "@kate_tattoo · бот"])
        #expect(byTitle["Telegram"]?.conflicts == false)
    }

    @Test("Telegram reads as the handle, the bot or nothing")
    func telegramText() {
        #expect(DuplicateComparison.telegram(card(1, "А", telegramNick: "nick", linked: true)) == "@nick · бот")
        #expect(DuplicateComparison.telegram(card(1, "А", linked: true)) == "Бот подключён")
        #expect(DuplicateComparison.telegram(card(1, "А", username: "seen")) == "@seen")
        #expect(DuplicateComparison.telegram(card(1, "А")) == nil)
    }

    // MARK: - What the merge gives

    @Test("Empty fields fill in from the merged card, the kept card's own values stay")
    func fills() {
        let kept = card(1, "Анна", instagram: "anna.main", notes: "Аллергия на никель")
        let source = card(
            2, "Анна", lastName: "Иванова", phone: "+79990000002", instagram: "anna.other", telegramNick: "anna_iv",
            birthday: "1995-04-12", notes: "Любит маленькие серьги", source: "instagram"
        )
        let plan = ClientMergePlan(kept: kept, sources: [source])
        let lines = Dictionary(uniqueKeysWithValues: plan.lines.map { ($0.field, $0) })

        #expect(plan.lines.map(\.field) == [.lastName, .phone, .birthday, .telegramNick, .instagram, .source, .notes])
        #expect(lines[.lastName]?.value == "Иванова")
        #expect(lines[.lastName]?.origin == .filled(from: "Анна Иванова"))
        #expect(lines[.phone]?.value == "+7 999 000-00-02")
        #expect(lines[.birthday]?.value == CalendarDay.date(from: "1995-04-12").map(DateText.fullDate))
        #expect(lines[.instagram]?.value == "@anna.main")
        #expect(lines[.instagram]?.origin == .kept)
        #expect(lines[.source]?.value == "Instagram")
        #expect(lines[.notes]?.value == "Аллергия на никель\n\nЛюбит маленькие серьги")
        #expect(lines[.notes]?.origin == .joined)
        #expect(plan.filledFields == [.lastName, .phone, .birthday, .telegramNick, .source, .notes])
        #expect(plan.losses == [ClientMergeLoss(field: .instagram, value: "@anna.other", from: "Анна Иванова", fromId: 2)])
        #expect(ClientMergeOrigin.filled(from: "Анна").caption == "Из карточки «Анна»")
        #expect(ClientMergeOrigin.kept.caption == nil)
    }

    @Test("Notes are not doubled, the same value is no loss, a last name the name already holds is not added")
    func noDoubling() {
        let kept = card(1, "Анна Иванова", phone: "+79990000001", instagram: "Anna.Main", notes: "Аллергия на никель")
        let source = card(2, "Анна", lastName: "ИВАНОВА", phone: "+79990000001", instagram: "anna.main", notes: " на никель ")
        let plan = ClientMergePlan(kept: kept, sources: [source])
        #expect(plan.lines.first { $0.field == .lastName } == nil)
        #expect(plan.lines.first { $0.field == .notes }?.value == "Аллергия на никель")
        #expect(plan.losses.isEmpty)
        #expect(plan.filledFields.isEmpty)

        let longer = ClientMergePlan(kept: card(1, "Анна", notes: "Никель"), sources: [card(2, "Анна", notes: "Никель, золото")])
        #expect(longer.lines.first { $0.field == .notes }?.value == "Никель, золото")

        // An older card holds the whole name in `name`: its last name still carries over.
        let legacy = ClientMergePlan(kept: card(1, "Анна"), sources: [card(2, "Анна  Иванова")])
        #expect(legacy.lines.first { $0.field == .lastName }?.value == "Иванова")
    }

    @Test("The kept card's Telegram link wins; without one it takes the merged card's")
    func telegramLink() {
        let linkedSource = card(2, "Анна", linked: true, username: "anna_two")
        let takes = ClientMergePlan(kept: card(1, "Анна"), sources: [linkedSource])
        #expect(takes.lines.first { $0.field == .telegramBot }?.value == "Подключён · @anna_two")
        #expect(takes.filledFields == [.telegramBot])

        let keeps = ClientMergePlan(kept: card(1, "Анна", linked: true), sources: [linkedSource])
        #expect(keeps.lines.first { $0.field == .telegramBot }?.value == "Подключён")
        #expect(keeps.lines.first { $0.field == .telegramBot }?.origin == .kept)
    }

    @Test("Several cards fill in order: the first one with a value wins")
    func severalSources() {
        let plan = ClientMergePlan(
            kept: card(1, "Анна", stats: stats(visits: 5, spent: 10_000)),
            sources: [
                card(2, "Анна", phone: "+79990000002", stats: stats(visits: 2, spent: 3_000, upcoming: 1)),
                card(3, "Анна", phone: "+79990000003", birthday: "1995-04-12", stats: stats(visits: 1, spent: 2_500)),
                card(1, "Анна"),
            ]
        )
        #expect(plan.sources.map(\.id) == [2, 3], "the kept card is never merged into itself")
        #expect(plan.lines.first { $0.field == .phone }?.origin == .filled(from: "Анна"))
        #expect(plan.lines.first { $0.field == .phone }?.value == "+7 999 000-00-02")
        #expect(plan.losses.map(\.field) == [.phone])
        #expect(plan.losses.map(\.id) == ["phone:3"], "a loss is told apart by its card")
        #expect(plan.movedVisits == 3)
        #expect(plan.movedSpent == 5_500)
        #expect(plan.movedSummary == "3 визита, покупки на \(Money.format(5_500)), 1 предстоящая запись")
    }

    @Test("The confirmation says what moves, what fills in and which cards disappear")
    func confirmation() {
        let kept = card(1, "Анна", lastName: "Иванова", phone: "+79990000001")
        let source = card(2, "Анна", phone: "+79990000002", birthday: "1995-04-12", stats: stats(visits: 2, spent: 3_500))
        #expect(
            ClientMergePlan(kept: kept, sources: [source]).confirmationMessage
                == "К карточке «Анна Иванова» перейдут 2 визита, покупки на \(Money.format(3_500)), а также бонусы, сертификаты, "
                + "переписка в Telegram и история. Заполнятся: дата рождения. Карточка «Анна» (+7 999 000-00-02) исчезнет. "
                + "Отменить объединение нельзя."
        )
        let two = ClientMergePlan(kept: kept, sources: [card(2, "Аня"), card(3, "Анна")])
        #expect(
            two.confirmationMessage
                == "К карточке «Анна Иванова» перейдут бонусы, сертификаты, переписка в Telegram и история. "
                + "Карточки «Аня», «Анна» исчезнут. Отменить объединение нельзя."
        )
    }

    @Test("The card with most visits, then spent, stays; of two the other one is merged, in a bigger group none")
    func defaults() throws {
        let few = card(1, "Анна", stats: stats(visits: 1, spent: 9_000))
        let many = card(2, "Анна", stats: stats(visits: 4, spent: 100))
        let richer = card(3, "Анна", stats: stats(visits: 4, spent: 200))
        let noStats = card(4, "Анна")
        #expect(ClientMergeDefaults.kept(among: [few, many, richer])?.id == 3)
        #expect(ClientMergeDefaults.kept(among: [noStats, card(5, "Анна")])?.id == 4, "a tie keeps the first")
        #expect(ClientMergeDefaults.kept(among: []) == nil)
        #expect(ClientMergeDefaults.selected(in: [few, many], keptId: 2) == [1])
        #expect(ClientMergeDefaults.selected(in: [few, many, richer], keptId: 3).isEmpty)
    }
}
