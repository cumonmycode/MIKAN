import Foundation
import Testing
@testable import MIKAN

/// «Журнал действий»: decoding `GET /audit`, who did it, day sections and the query of each screen.
struct AuditLogTests {
    /// An employee in the app with nested `changes`, a client in the bot with `changes: null`,
    /// and a newer server's source and entity without `changes` at all.
    private let page = #"""
    { "items": [
        { "id": 3, "at": "<T>", "employee": { "id": 2, "name": "Анна", "color": "#FF7A1A" },
          "source": "app", "action": "appointment.update", "entity": "appointment", "entityId": 1846,
          "summary": "Запись №1846 (Анна Иванова) перенесена с 20 октября, 14:00 на 21 октября, 15:00",
          "changes": { "startsAt": { "from": "2026-10-20T11:00:00.000Z", "to": "2026-10-21T12:00:00.000Z" },
                       "services": { "from": [ { "id": 3, "price": 2500 } ], "to": [] },
                       "notes": { "from": null, "to": "Эскиз" }, "price": { "from": 8000, "to": 9500.5 },
                       "flags": [ true, false, null, { "deep": [ 1, "два" ] } ] } },
        { "id": 2, "at": "<T>", "employee": null, "source": "bot", "action": "booking.create",
          "entity": "bot", "entityId": 12, "summary": "Заявка №12 (Мария Ким)", "changes": null },
        { "id": 1, "at": "<T>", "employee": null, "source": "import", "action": "gift.create",
          "entity": "gift_card", "entityId": null, "summary": "Сертификат на 5 000 ₽" }
      ],
      "total": 123 }
    """#

    private func entry(
        id: Int = 1,
        at: Date = Fixtures.referenceDate,
        employee: EmployeeRef? = EmployeeRef(id: 2, name: "Анна", color: "#FF7A1A"),
        source: AuditSource = .app,
        entity: String = "appointment",
        summary: String = "Запись №1846 подтверждена"
    ) -> AuditEntry {
        AuditEntry(
            id: id, at: at, employee: employee, source: source, action: "appointment.update",
            entity: entity, entityId: 1846, summary: summary
        )
    }

    // MARK: - Decoding

    @Test("A page decodes whatever `changes` holds, with null employees and a newer server's values", arguments: [true, false])
    func decodesPage(fractional: Bool) throws {
        let response = try Fixtures.decode(ItemsResponse<AuditEntry>.self, page, fractional: fractional)
        #expect(response.total == 123)
        #expect(response.items.map(\.id) == [3, 2, 1])

        let update = response.items[0]
        #expect(update.at == Fixtures.referenceDate)
        #expect(update.employee == EmployeeRef(id: 2, name: "Анна", color: "#FF7A1A"))
        #expect(update.source == .app)
        #expect(update.action == "appointment.update")
        #expect(update.entity == "appointment")
        #expect(update.entityId == 1846)
        #expect(update.summary.hasPrefix("Запись №1846 (Анна Иванова) перенесена"))

        let bot = response.items[1]
        #expect(bot.employee == nil)
        #expect(bot.source == .bot)

        let newer = response.items[2]
        #expect(newer.source == .other, "an unknown source must not break the list")
        #expect(newer.entity == "gift_card")
        #expect(newer.entityId == nil)
    }

    @Test("Every documented source decodes", arguments: [
        ("app", AuditSource.app), ("bot_staff", .botStaff), ("bot", .bot), ("system", .system), ("cron", .other),
    ])
    func decodesSource(raw: String, source: AuditSource) throws {
        let json = #"{ "id": 1, "at": "<T>", "employee": null, "source": "\#(raw)", "action": "a", "entity": "e", "entityId": 1, "summary": "s" }"#
        #expect(try Fixtures.decode(AuditEntry.self, json).source == source)
    }

    // MARK: - Texts

    @Test("Who did it: the employee, through the bot, a client in the bot or the server by itself")
    func actorLabels() {
        #expect(AuditLogText.actor(of: entry(source: .app)) == "Анна")
        #expect(AuditLogText.actor(of: entry(employee: nil, source: .app)) == "Сотрудник")
        #expect(AuditLogText.actor(of: entry(source: .botStaff)) == "Анна · через бота")
        #expect(AuditLogText.actor(of: entry(employee: nil, source: .botStaff)) == "Сотрудник · через бота")
        #expect(AuditLogText.actor(of: entry(employee: nil, source: .bot)) == "Клиент в боте")
        #expect(AuditLogText.actor(of: entry(employee: nil, source: .system)) == "Автоматически")
        #expect(AuditLogText.actor(of: entry(source: .other)) == "Анна")
        #expect(AuditLogText.actor(of: entry(employee: nil, source: .other)) == "Автоматически")
    }

    @Test("A row without a summary shows its action")
    func summaryFallback() {
        #expect(AuditLogText.summary(of: entry(summary: "Клиент добавлен")) == "Клиент добавлен")
        #expect(AuditLogText.summary(of: entry(summary: "  ")) == "appointment.update")
    }

    @Test("Section titles follow docs/API.md; an unknown entity shows as is")
    func sectionTitles() {
        let documented = "appointment,deposit,sale,receipt,cash,client,service,product,stock,category,aftercare,knowledge,employee,schedule,payroll,settings,bot,campaign,certificate,waitlist,portfolio"
        #expect(AuditSection.allCases.map(\.rawValue).joined(separator: ",") == documented)
        #expect(AuditLogText.sectionTitle("waitlist") == "Лист ожидания")
        #expect(AuditLogText.sectionTitle("portfolio") == "Портфолио")
        #expect(AuditLogText.sectionTitle("certificate") == "Сертификаты")
        #expect(AuditLogText.sectionTitle("campaign") == "Рассылки")
        #expect(AuditLogText.sectionTitle("appointment") == "Записи")
        #expect(AuditLogText.sectionTitle("deposit") == "Предоплаты")
        #expect(AuditLogText.sectionTitle("receipt") == "Открытые чеки")
        #expect(AuditLogText.sectionTitle("aftercare") == "Памятки")
        #expect(AuditLogText.sectionTitle("bot") == "Бот")
        #expect(AuditLogText.sectionTitle("gift_card") == "gift_card")
        #expect(Set(AuditSection.allCases.map(\.title)).count == AuditSection.allCases.count, "titles are distinct")
    }

    @Test("The employee filter lists active employees first, then by name")
    func filterEmployees() {
        func employee(_ id: Int, _ name: String, active: Bool = true) -> Employee {
            Employee(id: id, name: name, login: "e\(id)", phone: nil, color: nil, isMaster: true, active: active, createdAt: .distantPast)
        }
        let employees = [employee(1, "Олег", active: false), employee(2, "Фатима"), employee(3, "Анна"), employee(4, "Борис", active: false)]
        #expect(AuditLogText.filterEmployees(employees).map(\.id) == [3, 2, 4, 1])
        #expect(AuditLogText.employeeName(2, in: employees) == "Фатима")
        #expect(AuditLogText.employeeName(9, in: employees) == "Сотрудник")
    }

    // MARK: - Days

    private let calendar = Calendar.app

    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 12, _ minute: Int = 0) throws -> Date {
        try #require(calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute)))
    }

    @Test("Entries group by calendar day, newest day first, keeping the server's order inside a day")
    func groupsByDay() throws {
        let today = try date(2026, 10, 15, 0)
        let yesterday = try date(2026, 10, 14, 0)
        let earlier = try date(2026, 10, 1, 0)
        let lastYear = try date(2025, 12, 31, 0)
        let entries = [
            entry(id: 5, at: try date(2026, 10, 15, 23, 59)),
            entry(id: 4, at: today),
            entry(id: 3, at: try date(2026, 10, 14, 23, 59)),
            entry(id: 2, at: try date(2026, 10, 1, 9)),
            entry(id: 1, at: try date(2025, 12, 31, 18)),
        ]
        let days = AuditDay.grouping(entries, calendar: calendar)
        #expect(days.map(\.start) == [today, yesterday, earlier, lastYear])
        #expect(days.map { $0.entries.map(\.id) } == [[5, 4], [3], [2], [1]])
        #expect(AuditDay.grouping([], calendar: calendar).isEmpty)
    }

    @Test("Day titles: today, yesterday, the date, and the year for another year")
    func dayTitles() throws {
        let now = try date(2026, 10, 15, 15)
        let today = try date(2026, 10, 15, 0)
        let yesterday = try date(2026, 10, 14, 0)
        let earlier = try date(2026, 10, 1, 0)
        let lastYear = try date(2025, 10, 15, 0)
        #expect(AuditLogText.dayTitle(today, now: now, calendar: calendar) == "Сегодня")
        #expect(AuditLogText.dayTitle(yesterday, now: now, calendar: calendar) == "Вчера")
        #expect(AuditLogText.dayTitle(earlier, now: now, calendar: calendar) == DateText.dayMonth(earlier))
        #expect(AuditLogText.dayTitle(lastYear, now: now, calendar: calendar) == DateText.fullDate(lastYear))
        #expect(DateText.fullDate(lastYear).contains("2025"))

        let newYear = try date(2026, 1, 1, 10)
        let newYearsEve = try date(2025, 12, 31, 0)
        #expect(AuditLogText.dayTitle(newYearsEve, now: newYear, calendar: calendar) == "Вчера", "across the new year")
    }

    // MARK: - Query

    private func pairs(_ query: AuditQuery) -> [String: String] {
        Dictionary(uniqueKeysWithValues: query.parameters.map { ($0.name, $0.value ?? "") })
    }

    @Test("The whole studio's log sends only the filters that are set")
    func studioQuery() {
        #expect(pairs(AuditScope.studio.query(AuditFilter(), offset: 0)) == ["limit": "50", "offset": "0"])

        let filtered = AuditScope.studio.query(AuditFilter(employeeId: 2, section: .deposit), offset: 100, limit: 50)
        #expect(pairs(filtered) == ["employeeId": "2", "entity": "deposit", "limit": "50", "offset": "100"])
        #expect(!AuditFilter().isActive)
        #expect(AuditFilter(section: .cash).isActive)
    }

    @Test("A card's history asks for its own entities and id, whatever the filter", arguments: [
        (AuditScope.appointment(id: 1846), "appointment,deposit", "1846"),
        (.client(id: 7), "client", "7"),
        (.sale(id: 1580), "sale", "1580"),
        (.product(id: 3), "product,stock", "3"),
        (.certificate(id: 12), "certificate", "12"),
    ])
    func cardQuery(scope: AuditScope, entity: String, entityId: String) {
        let query = scope.query(AuditFilter(employeeId: 2, section: .cash), offset: 50)
        #expect(pairs(query) == ["entity": entity, "entityId": entityId, "limit": "50", "offset": "50"])
        #expect(!scope.hasFilters)
        #expect(scope.title == "История изменений")
    }

    @Test("Instants, source and limits of a full query")
    func fullQuery() {
        let query = AuditQuery(
            from: Fixtures.referenceDate, to: Fixtures.referenceDate.addingTimeInterval(86_400),
            employeeId: 4, sections: [.cash, .payroll], entityId: 9, source: .botStaff, limit: 500, offset: -5
        )
        #expect(query.parameters.map(\.name) == ["from", "to", "employeeId", "entity", "entityId", "source", "limit", "offset"])
        #expect(pairs(query) == [
            "from": "2026-10-15T11:00:00.000Z", "to": "2026-10-16T11:00:00.000Z", "employeeId": "4",
            "entity": "cash,payroll", "entityId": "9", "source": "bot_staff", "limit": "200", "offset": "0",
        ])
        #expect(pairs(AuditQuery(limit: 0))["limit"] == "1")
    }

    @Test("The comma-separated entity list is percent-encoded in the URL")
    @MainActor
    func requestURL() throws {
        let api = APIClient(serverURL: try #require(URL(string: "https://mikan.example")))
        let query = AuditScope.appointment(id: 1846).query(AuditFilter(), offset: 0)
        let request = try api.makeRequest(.get, "audit", query: query.parameters, body: nil, contentType: "application/json", timeout: 20)
        #expect(request.url?.absoluteString == "https://mikan.example/api/audit?entity=appointment%2Cdeposit&entityId=1846&limit=50&offset=0")
    }
}
