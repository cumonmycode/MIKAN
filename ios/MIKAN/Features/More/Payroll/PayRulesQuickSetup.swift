import Foundation

/// One employee on «Правила зарплаты»: who and the rules in force today (`nil` — none yet).
nonisolated struct PayRulesOverviewRow: Identifiable, Hashable, Sendable {
    let employee: Employee
    let rules: PayRules?

    var id: Int { employee.id }

    /// Masters first, then the others, each by name.
    static func sorted(_ rows: [PayRulesOverviewRow]) -> [PayRulesOverviewRow] {
        rows.sorted {
            if $0.employee.isMaster != $1.employee.isMaster { return $0.employee.isMaster }
            return $0.employee.name.localizedCompare($1.employee.name) == .orderedAscending
        }
    }
}

/// «Быстрая настройка»: one share of the service revenue for several masters at once (the «60 на 40» studios talk
/// about), plus the share of goods and whether consumables come off first.
nonisolated struct PayRulesQuickSetup: Hashable, Sendable {
    static let presets = [30, 40, 50, 60]
    static let defaultShare = 40

    /// The master's share of the service revenue, %.
    var masterShare: Int
    /// The share of jewelry and goods they sell, %.
    var productPercent: Int
    var deductMaterials: Bool
    var effectiveFrom: Date
    var selected: Set<Int>

    /// Starts from what most masters have today (or 40 %), counted from the first day of this month so this month's
    /// statements change at once, with every active master selected.
    init(rows: [PayRulesOverviewRow], now: Date = .now, calendar: Calendar = .app) {
        let masters = rows.filter { $0.employee.isMaster && $0.employee.active }
        let shares = masters.compactMap { $0.rules?.servicePercent }.filter { $0 > 0 }.map { Int($0.rounded()) }
        masterShare = Self.mostCommon(shares) ?? Self.defaultShare
        let products = masters.compactMap { $0.rules?.productPercent }.map { Int($0.rounded()) }
        productPercent = Self.mostCommon(products) ?? 0
        deductMaterials = masters.contains { $0.rules?.deductMaterials == true }
        effectiveFrom = calendar.dateInterval(of: .month, for: now)?.start ?? calendar.startOfDay(for: now)
        selected = Set(masters.map(\.id))
    }

    /// The studio's part, for the «Мастеру 40 % · студии 60 %» line.
    var studioShare: Int { max(0, 100 - masterShare) }

    var shareText: String { "Мастеру \(masterShare) % · студии \(studioShare) %" }

    /// The first thing to fix before saving, or `nil`.
    var problem: String? {
        if selected.isEmpty { return "Выберите, кому применить." }
        if !(0...100).contains(masterShare) || !(0...100).contains(productPercent) {
            return "Процент должен быть от 0 до 100."
        }
        return nil
    }

    /// The new version for one employee: the shares from here; salary and per-day pay stay as they were; percents
    /// per service category are cleared so the one share really applies to every service.
    func rules(from current: PayRules?) -> PayRules {
        var rules = current ?? PayRules()
        rules.servicePercent = Double(masterShare)
        rules.categoryPercent = CategoryPercents()
        rules.productPercent = Double(productPercent)
        rules.deductMaterials = deductMaterials
        return rules
    }

    func body(for row: PayRulesOverviewRow, calendar: Calendar = .app) -> PayRulesBody {
        PayRulesBody(effectiveFrom: CalendarDay.string(from: effectiveFrom, calendar: calendar), rules: rules(from: row.rules))
    }

    private static func mostCommon(_ values: [Int]) -> Int? {
        let counts = Dictionary(values.map { ($0, 1) }, uniquingKeysWith: +)
        return counts.max { $0.value == $1.value ? $0.key > $1.key : $0.value < $1.value }?.key
    }
}
