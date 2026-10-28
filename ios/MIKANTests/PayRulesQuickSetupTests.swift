import Foundation
import Testing
@testable import MIKAN

/// «Быстрая настройка» of pay rules (docs/API.md «PayRules»): the «60 на 40» share for several masters at once.
struct PayRulesQuickSetupTests {
    private static func employee(_ id: Int, _ name: String, master: Bool = true, active: Bool = true) -> Employee {
        Employee(id: id, name: name, login: "e\(id)", phone: nil, color: nil, isMaster: master, active: active, createdAt: .distantPast)
    }

    private static func rules(service: Double, product: Double = 0, salary: Int = 0, perDay: Int = 0) -> PayRules {
        var rules = PayRules()
        rules.servicePercent = service
        rules.productPercent = product
        rules.salaryMonthly = salary
        rules.perDay = perDay
        return rules
    }

    private static let now = Date(timeIntervalSince1970: 1_792_450_000) // 20 October 2026

    @Test("starts at 40 % for every active master when nobody has rules, from the 1st of this month")
    func defaults() {
        let rows = [
            PayRulesOverviewRow(employee: Self.employee(1, "Админ", master: false), rules: nil),
            PayRulesOverviewRow(employee: Self.employee(2, "Амина"), rules: nil),
            PayRulesOverviewRow(employee: Self.employee(3, "Фатима"), rules: nil),
            PayRulesOverviewRow(employee: Self.employee(4, "Муха", active: false), rules: nil),
        ]
        let setup = PayRulesQuickSetup(rows: rows, now: Self.now, calendar: .app)
        #expect(setup.masterShare == 40)
        #expect(setup.productPercent == 0)
        #expect(setup.selected == [2, 3])
        #expect(CalendarDay.string(from: setup.effectiveFrom, calendar: .app) == "2026-10-01")
        #expect(setup.shareText == "Мастеру 40 % · студии 60 %")
        #expect(setup.problem == nil)
    }

    @Test("starts from the share most masters already have")
    func mostCommonShare() {
        let rows = [
            PayRulesOverviewRow(employee: Self.employee(2, "Амина"), rules: Self.rules(service: 60, product: 10)),
            PayRulesOverviewRow(employee: Self.employee(3, "Фатима"), rules: Self.rules(service: 60, product: 10)),
            PayRulesOverviewRow(employee: Self.employee(4, "Кантемир"), rules: Self.rules(service: 50)),
        ]
        let setup = PayRulesQuickSetup(rows: rows, now: Self.now)
        #expect(setup.masterShare == 60)
        #expect(setup.productPercent == 10)
        #expect(setup.studioShare == 40)
    }

    @Test("keeps salary and per-day pay, clears category percents")
    func keepsSalary() {
        var current = Self.rules(service: 30, salary: 20000, perDay: 1500)
        current.categoryPercent.tattoo = 50
        let row = PayRulesOverviewRow(employee: Self.employee(2, "Амина"), rules: current)
        var setup = PayRulesQuickSetup(rows: [row], now: Self.now)
        setup.masterShare = 40
        setup.productPercent = 10
        setup.deductMaterials = true
        let rules = setup.rules(from: current)
        #expect(rules.servicePercent == 40)
        #expect(rules.productPercent == 10)
        #expect(rules.deductMaterials)
        #expect(rules.salaryMonthly == 20000)
        #expect(rules.perDay == 1500)
        #expect(rules.categoryPercent == CategoryPercents())
        #expect(setup.body(for: row).effectiveFrom == "2026-10-01")
    }

    @Test("needs someone selected and percents within 0…100")
    func problems() {
        var setup = PayRulesQuickSetup(rows: [PayRulesOverviewRow(employee: Self.employee(2, "Амина"), rules: nil)], now: Self.now)
        setup.selected = []
        #expect(setup.problem == "Выберите, кому применить.")
        setup.selected = [2]
        setup.masterShare = 120
        #expect(setup.problem == "Процент должен быть от 0 до 100.")
    }

    @Test("masters come first, then by name")
    func ordering() {
        let rows = PayRulesOverviewRow.sorted([
            PayRulesOverviewRow(employee: Self.employee(1, "Администратор", master: false), rules: nil),
            PayRulesOverviewRow(employee: Self.employee(3, "Фатима"), rules: nil),
            PayRulesOverviewRow(employee: Self.employee(2, "Амина"), rules: nil),
        ])
        #expect(rows.map(\.employee.name) == ["Амина", "Фатима", "Администратор"])
    }
}
