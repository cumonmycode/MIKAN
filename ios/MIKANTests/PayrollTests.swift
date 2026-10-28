import Foundation
import Testing
@testable import MIKAN

/// Payroll JSON shaped like docs/API.md («PayRules», «PayrollStatement», «PayrollAdjustment»).
private enum PayrollJSON {
    static let employee = ##"{ "id": 3, "name": "Фатима", "color": "#FF7A1A" }"##

    static let rules = """
    { "salaryMonthly": 0, "perDay": 1500, "servicePercent": 40,
      "categoryPercent": { "tattoo": 50, "piercing": null, "other": null },
      "productPercent": 10, "deductMaterials": true }
    """

    static let statement = """
    { "employee": \(employee), "from": "2026-10-01", "to": "2026-10-31",
      "services": { "visits": 42, "revenue": 210000, "materials": 6300, "amount": 81480 },
      "products": { "revenue": 35000, "amount": 3500 },
      "salary": 0, "days": 18, "perDay": 27000,
      "adjustments": { "bonus": 5000, "penalty": 0, "advance": 20000, "payout": 0 },
      "earned": 116980, "paid": 20000, "due": 96980,
      "lines": [ { "date": "2026-10-05", "kind": "service", "appointmentId": 12, "saleId": 40, "name": "Тату мини",
                   "category": "tattoo", "revenue": 5000, "materials": 100, "percent": 50, "amount": 2450 },
                 { "date": "2026-10-05", "kind": "product", "appointmentId": null, "saleId": 41, "name": "Лабрет",
                   "category": null, "revenue": 900, "materials": 0, "percent": 12.5, "amount": 113 } ],
      "adjustmentItems": [ { "id": 1, "employee": \(employee), "date": "2026-10-15", "kind": "advance", "amount": 20000,
                             "note": "Аванс", "cashOperationId": 31, "createdBy": null, "createdAt": "2026-10-15T11:00:00.000Z" } ] }
    """

    static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.makeDecoder().decode(T.self, from: Data(json.utf8))
    }
}

private func day(_ year: Int, _ month: Int, _ day: Int, hour: Int = 12) -> Date {
    Calendar.app.date(from: DateComponents(year: year, month: month, day: day, hour: hour)) ?? .distantPast
}

struct PayrollDecodingTests {
    @Test("A detailed statement decodes its totals, lines and adjustments")
    func decodesStatement() throws {
        let statement = try PayrollJSON.decode(PayrollStatement.self, PayrollJSON.statement)

        #expect(statement.id == 3)
        #expect(statement.services == .init(visits: 42, revenue: 210_000, materials: 6300, amount: 81_480))
        #expect(statement.adjustments.advance == 20_000)
        #expect(statement.due == 96_980)
        let lines = try #require(statement.lines)
        #expect(lines.map(\.isService) == [true, false])
        #expect(lines[1].category == nil)
        #expect(lines[1].percent == 12.5)
        let advance = try #require(statement.adjustmentItems?.first)
        #expect(advance.kind == .advance)
        #expect(advance.cashOperationId == 31)
        #expect(advance.createdBy == nil)
    }

    @Test("A list statement has no lines; rules decode with category overrides")
    func decodesListAndRules() throws {
        let list = try PayrollJSON.decode(PayrollList.self, #"{ "from": "2026-10-01", "to": "2026-10-31", "items": [] }"#)
        #expect(list.items.isEmpty)

        let response = try PayrollJSON.decode(PayRulesResponse.self, """
        { "current": \(PayrollJSON.rules),
          "history": [ { "effectiveFrom": "2026-10-01", "rules": \(PayrollJSON.rules), "createdBy": \(PayrollJSON.employee),
                         "createdAt": "2026-10-01T09:00:00.000Z" } ] }
        """)
        let rules = try #require(response.current)
        #expect(rules.percent(for: .tattoo) == 50)
        #expect(rules.percent(for: .piercing) == 40)
        #expect(response.history.map(\.id) == ["2026-10-01"])
    }

    @Test("Saving flattens the rules next to the date")
    func encodesRulesBody() throws {
        var rules = PayRules(perDay: 1500, servicePercent: 40, productPercent: 10)
        rules.categoryPercent.tattoo = 50
        let data = try JSONCoding.makeEncoder().encode(PayRulesBody(effectiveFrom: "2026-11-01", rules: rules))
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])

        #expect(object["effectiveFrom"] as? String == "2026-11-01")
        #expect(object["perDay"] as? Int == 1500)
        #expect(object["servicePercent"] as? Double == 40)
        #expect(object["deductMaterials"] as? Bool == false)
        let categories = try #require(object["categoryPercent"] as? [String: Any])
        #expect(categories["tattoo"] as? Double == 50)
        #expect(categories["piercing"] == nil)
        #expect(object["rules"] == nil)
    }
}

struct PayrollPeriodTests {
    @Test("This month runs to today, last month is whole, a custom range is ordered")
    func ranges() {
        let now = day(2026, 10, 19)
        let thisMonth = PayrollPeriodOption.thisMonth.range(now: now, customFrom: now, customTo: now)
        #expect(thisMonth.from == "2026-10-01")
        #expect(thisMonth.to == "2026-10-19")

        let january = day(2027, 1, 10)
        let lastMonth = PayrollPeriodOption.lastMonth.range(now: january, customFrom: january, customTo: january)
        #expect(lastMonth.from == "2026-12-01")
        #expect(lastMonth.to == "2026-12-31")

        let custom = PayrollPeriodOption.custom.range(now: now, customFrom: day(2026, 10, 15), customTo: day(2026, 9, 20))
        #expect(custom.from == "2026-09-20")
        #expect(custom.to == "2026-10-15")
    }

    @Test("A whole month is titled by its name, any other range by its days")
    func titles() {
        let now = day(2026, 10, 19)
        let september = PayrollRange(first: day(2026, 9, 1, hour: 0), last: day(2026, 9, 30, hour: 0))
        #expect(september.isWholeMonth())
        #expect(september.title(now: now) == "Сентябрь 2026")

        let partial = PayrollRange(first: day(2026, 10, 1, hour: 0), last: day(2026, 10, 19, hour: 0))
        #expect(!partial.isWholeMonth())
        #expect(partial.title(now: now) == "1 – 19 октября")
    }
}

struct PayrollTextTests {
    private let nbsp = "\u{00A0}"

    @Test("Percents, dues and adjustment amounts")
    func basics() {
        #expect(PayrollText.percent(40) == "40\(nbsp)%")
        #expect(PayrollText.percent(12.5) == "12,5\(nbsp)%")
        #expect(PayrollText.dueTitle(100) == "К выплате")
        #expect(PayrollText.dueTitle(-1) == "Переплата")
        #expect(PayrollText.visits(1) == "1 визит")
        #expect(PayrollText.visits(3) == "3 визита")
        #expect(PayrollText.visits(12) == "12 визитов")
    }

    @Test("A line shows how it was counted")
    func lineFormula() throws {
        let statement = try PayrollJSON.decode(PayrollStatement.self, PayrollJSON.statement)
        let lines = try #require(statement.lines)
        #expect(PayrollText.lineFormula(lines[0]) == "5\(nbsp)000\(nbsp)₽ − 100\(nbsp)₽ расходники × 50\(nbsp)%")
        #expect(PayrollText.lineFormula(lines[1]) == "900\(nbsp)₽ × 12,5\(nbsp)%")
        #expect(PayrollText.lineKind(lines[0]) == "Тату")
        #expect(PayrollText.lineKind(lines[1]) == "Товар")
        let advance = try #require(statement.adjustmentItems?.first)
        #expect(PayrollText.adjustmentAmount(advance) == "20\(nbsp)000\(nbsp)₽")
    }

    @Test("Rules read as one sentence")
    func rulesSummary() {
        #expect(PayrollText.rulesSummary(PayRules()) == "Ничего не начисляется")
        var rules = PayRules(salaryMonthly: 50_000, perDay: 1500, servicePercent: 40, productPercent: 10, deductMaterials: true)
        rules.categoryPercent.tattoo = 50
        #expect(PayrollText.rulesSummary(rules) == [
            "Оклад 50\(nbsp)000\(nbsp)₽ в месяц",
            "1\(nbsp)500\(nbsp)₽ за рабочий день",
            "40\(nbsp)% с услуг (тату 50\(nbsp)%)",
            "10\(nbsp)% с товаров",
            "минус расходники",
        ].joined(separator: " · "))
    }
}

struct PayrollDraftTests {
    @Test("The rules form starts from the rules, checks percents and builds the body")
    func rulesDraft() {
        var rules = PayRules(perDay: 1500, servicePercent: 12.5)
        rules.categoryPercent.piercing = 30
        var draft = PayRulesDraft(rules: rules, effectiveFrom: day(2026, 11, 1))
        #expect(draft.servicePercent == 13)
        #expect(draft.categoryPercents == [.piercing: 30])
        #expect(draft.problem == nil)

        draft.categoryPercents[.tattoo] = 120
        #expect(draft.problem == "Процент не может быть больше 100.")
        draft.categoryPercents[.tattoo] = nil
        draft.servicePercent = 40

        let body = draft.body()
        #expect(body.effectiveFrom == "2026-11-01")
        #expect(body.rules.servicePercent == 40)
        #expect(body.rules.categoryPercent == CategoryPercents(tattoo: nil, piercing: 30, other: nil))
        #expect(body.rules.perDay == 1500)

        let empty = PayRulesDraft(rules: nil, effectiveFrom: day(2026, 11, 1))
        #expect(empty.rules == PayRules())
    }

    @Test("The date hint tells a replacement, a backdated change and a new version apart")
    func dateHint() {
        let now = day(2026, 10, 19)
        let history = [PayRulesVersion(effectiveFrom: "2026-10-01", rules: PayRules(), createdBy: nil, createdAt: now)]
        let replacing = PayRulesDraft(rules: nil, effectiveFrom: day(2026, 10, 1))
        #expect(replacing.dateHint(history: history, now: now).hasPrefix("Заменит правила"))
        let backdated = PayRulesDraft(rules: nil, effectiveFrom: day(2026, 10, 10))
        #expect(backdated.dateHint(history: history, now: now).hasPrefix("Задним числом"))
        let planned = PayRulesDraft(rules: nil, effectiveFrom: day(2026, 11, 1))
        #expect(planned.dateHint(history: history, now: now).hasPrefix("Прежние правила"))
    }

    @Test("Only advances and payouts come from the till; an empty note is not sent")
    func adjustmentDraft() {
        var draft = PayrollAdjustmentDraft(kind: .advance, amount: 0, date: day(2026, 10, 15), note: "  ", fromCash: true)
        #expect(draft.problem == "Укажите сумму.")
        draft.amount = 20_000
        #expect(draft.problem == nil)
        #expect(draft.body(employeeId: 3) == PayrollAdjustmentBody(
            employeeId: 3, date: "2026-10-15", kind: .advance, amount: 20_000, note: nil, fromCash: true
        ))
        #expect(draft.cashHint(employeeName: "Фатима").contains("«Аванс: Фатима»"))

        draft.kind = .bonus
        draft.note = " За отзывы "
        #expect(!draft.canPayFromCash)
        #expect(draft.body(employeeId: 3).fromCash == false)
        #expect(draft.body(employeeId: 3).note == "За отзывы")
    }
}

/// A list statement of one day: only what the today card reads.
private func todayStatement(
    _ id: Int, _ name: String, earned: Int, visits: Int = 0, services: Int = 0, products: Int = 0, days: Int = 0
) -> PayrollStatement {
    PayrollStatement(
        employee: EmployeeRef(id: id, name: name, color: nil), from: "2026-10-26", to: "2026-10-26",
        services: .init(visits: visits, revenue: services * 2, materials: 0, amount: services),
        products: .init(revenue: products * 10, amount: products),
        salary: 0, days: days, perDay: 0,
        adjustments: .init(bonus: 0, penalty: 0, advance: 0, payout: 0),
        earned: earned, paid: 0, due: earned
    )
}

struct PayrollTodayTests {
    @Test("Today is a one-day range titled as today; another single day reads as its date")
    func range() {
        let now = day(2026, 10, 26, hour: 15)
        let today = PayrollTodaySummary.range(now: now)
        #expect(today.from == "2026-10-26")
        #expect(today.to == "2026-10-26")
        #expect(PayrollPeriodOption.today.range(now: now, customFrom: now, customTo: now) == today)
        #expect(today.title(now: now) == "Сегодня, 26 октября")

        let past = PayrollRange(first: day(2026, 10, 15, hour: 0), last: day(2026, 10, 15, hour: 0))
        #expect(past.title(now: now) == "15 октября")
    }

    @Test("«Сегодня» is the first chip, this month stays the default")
    func chips() {
        #expect(PayrollPeriodOption.allCases.first == .today)
        #expect(PayrollPeriodOption.today.title == "Сегодня")
        #expect(PayrollPeriodSelection().option == .thisMonth)
    }

    @Test("The day leaves out employees with nothing today and puts the most earned first, then by name")
    func summary() {
        let summary = PayrollTodaySummary([
            todayStatement(1, "Анна", earned: 0),
            todayStatement(2, "Борис", earned: 1200, visits: 1, services: 1200),
            todayStatement(3, "Фатима", earned: 4500, visits: 2, services: 4000, products: 500),
            todayStatement(4, "Вера", earned: 0, visits: 1, days: 1),
            todayStatement(5, "Алла", earned: 1200, products: 1200, days: 1),
        ])
        #expect(summary.statements.map(\.employee.name) == ["Фатима", "Алла", "Борис", "Вера"])
        #expect(summary.earned == 6900)
        #expect(summary.visits == 4)
        #expect(summary.statement(of: 2)?.earned == 1200)
        #expect(summary.statement(of: 1) == nil)
        #expect(!summary.isEmpty)
    }

    @Test("A day with nothing earned is empty, not an error; a penalty alone still shows")
    func emptyDay() {
        #expect(PayrollTodaySummary([]).isEmpty)
        let quiet = PayrollTodaySummary([todayStatement(1, "Анна", earned: 0)])
        #expect(quiet.isEmpty)
        #expect(quiet.earned == 0)
        #expect(quiet.statement(of: 1) == nil)

        let penalty = PayrollTodaySummary([todayStatement(1, "Анна", earned: -500)])
        #expect(penalty.statements.map(\.id) == [1])
        #expect(penalty.earned == -500)
    }
}
