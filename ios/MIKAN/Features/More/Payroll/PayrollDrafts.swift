import Foundation

/// The pay rules form: whole rubles and whole percents as typed; an empty category percent uses the general one.
nonisolated struct PayRulesDraft: Hashable, Sendable {
    var effectiveFrom: Date
    var salaryMonthly: Int
    var perDay: Int
    var servicePercent: Int
    var categoryPercents: [ServiceCategory: Int]
    var productPercent: Int
    var deductMaterials: Bool

    static let maxPercent = 100

    /// Starts from `rules` (the version in force) or from zeros.
    init(rules: PayRules?, effectiveFrom: Date) {
        let rules = rules ?? PayRules()
        self.effectiveFrom = effectiveFrom
        salaryMonthly = rules.salaryMonthly
        perDay = rules.perDay
        servicePercent = Self.whole(rules.servicePercent)
        categoryPercents = Dictionary(uniqueKeysWithValues: ServiceCategory.allCases.compactMap { category in
            rules.categoryPercent[category].map { (category, Self.whole($0)) }
        })
        productPercent = Self.whole(rules.productPercent)
        deductMaterials = rules.deductMaterials
    }

    private static func whole(_ percent: Double) -> Int { Int(percent.rounded()) }

    /// The first thing to fix before saving, or `nil`.
    var problem: String? {
        let percents = [servicePercent, productPercent] + Array(categoryPercents.values)
        return percents.contains { $0 > Self.maxPercent } ? "Процент не может быть больше \(Self.maxPercent)." : nil
    }

    var rules: PayRules {
        var categories = CategoryPercents()
        for category in ServiceCategory.allCases {
            categories[category] = categoryPercents[category].map(Double.init)
        }
        return PayRules(
            salaryMonthly: salaryMonthly,
            perDay: perDay,
            servicePercent: Double(servicePercent),
            categoryPercent: categories,
            productPercent: Double(productPercent),
            deductMaterials: deductMaterials
        )
    }

    func body(calendar: Calendar = .app) -> PayRulesBody {
        PayRulesBody(effectiveFrom: CalendarDay.string(from: effectiveFrom, calendar: calendar), rules: rules)
    }

    /// Under the date: what saving does to the history and to past statements.
    func dateHint(history: [PayRulesVersion], now: Date = .now, calendar: Calendar = .app) -> String {
        let date = CalendarDay.string(from: effectiveFrom, calendar: calendar)
        if history.contains(where: { $0.effectiveFrom == date }) {
            return "Заменит правила, которые действуют \(PayrollText.effectiveFrom(date))."
        }
        if calendar.startOfDay(for: effectiveFrom) < calendar.startOfDay(for: now) {
            return "Задним числом: расчёт \(PayrollText.effectiveFrom(date)) пересчитается по новым правилам."
        }
        return "Прежние правила останутся в истории и будут считать дни до этой даты."
    }
}

/// A bonus, penalty, advance or payout being added. Only advances and payouts can come from the till.
nonisolated struct PayrollAdjustmentDraft: Hashable, Sendable {
    var kind: PayrollAdjustmentKind = .advance
    var amount = 0
    var date = Date.now
    var note = ""
    var fromCash = false

    var canPayFromCash: Bool { kind.isPayment }

    var problem: String? { amount > 0 ? nil : "Укажите сумму." }

    func body(employeeId: Int, calendar: Calendar = .app) -> PayrollAdjustmentBody {
        PayrollAdjustmentBody(
            employeeId: employeeId,
            date: CalendarDay.string(from: date, calendar: calendar),
            kind: kind,
            amount: amount,
            note: note.trimmed.nonEmpty,
            fromCash: canPayFromCash && fromCash
        )
    }

    /// What the chosen kind does to the statement.
    var kindHint: String {
        switch kind {
        case .bonus: "Добавится к начисленному."
        case .penalty: "Вычтется из начисленного."
        case .advance: "Деньги, выданные до расчёта: уменьшат сумму к выплате."
        case .payout: "Выплата зарплаты: уменьшит сумму к выплате."
        }
    }

    /// «Сумма уйдёт из кассы открытой смены: «Аванс: Фатима».»
    func cashHint(employeeName: String) -> String {
        "Сумма уйдёт из кассы открытой смены с причиной «\(kind.title): \(employeeName)»."
    }
}
