import Foundation

/// Russian texts of the payroll screens.
nonisolated enum PayrollText {
    /// 40 → «40 %», 12.5 → «12,5 %».
    static func percent(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...1)).locale(.app)) + "\u{00A0}%"
    }

    static func visits(_ count: Int) -> String {
        Plural.count(count, one: "визит", few: "визита", many: "визитов")
    }

    /// «К выплате» while the studio owes, «Переплата» once more was paid than earned.
    static func dueTitle(_ due: Int) -> String {
        due < 0 ? "Переплата" : "К выплате"
    }

    /// How a line was counted: «2 700 ₽ × 40 %», «5 000 ₽ − 100 ₽ расходники × 50 %», «3 000 ₽ · правил ещё не было».
    static func lineFormula(_ line: PayrollLine) -> String {
        let base = Money.format(line.revenue) + (line.materials > 0 ? " − \(Money.format(line.materials)) расходники" : "")
        return line.percent > 0 ? "\(base) × \(percent(line.percent))" : "\(base) · без процента"
    }

    /// «Тату», «Пирсинг», «Другое» for services, «Товар» for products.
    static func lineKind(_ line: PayrollLine) -> String {
        guard line.isService else { return "Товар" }
        return line.category.flatMap(ServiceCategory.init(rawValue:))?.title ?? ServiceCategory.other.title
    }

    /// Bonuses add, penalties subtract, advances and payouts are money handed over.
    static func adjustmentAmount(_ adjustment: PayrollAdjustment) -> String {
        switch adjustment.kind {
        case .bonus: "+" + Money.format(adjustment.amount)
        case .penalty: Money.minus + Money.format(adjustment.amount)
        case .advance, .payout: Money.format(adjustment.amount)
        }
    }

    /// «Оклад 50 000 ₽ в месяц · 1 500 ₽ за рабочий день · 40 % с услуг (тату 50 %) · 10 % с товаров · минус расходники».
    static func rulesSummary(_ rules: PayRules) -> String {
        var parts: [String] = []
        if rules.salaryMonthly > 0 { parts.append("Оклад \(Money.format(rules.salaryMonthly)) в месяц") }
        if rules.perDay > 0 { parts.append("\(Money.format(rules.perDay)) за рабочий день") }
        let overrides = ServiceCategory.allCases.compactMap { category in
            rules.categoryPercent[category].map { "\(category.title.lowercased()) \(percent($0))" }
        }
        if rules.servicePercent > 0 || !overrides.isEmpty {
            let tail = overrides.isEmpty ? "" : " (\(overrides.joined(separator: ", ")))"
            parts.append("\(percent(rules.servicePercent)) с услуг\(tail)")
        }
        if rules.productPercent > 0 { parts.append("\(percent(rules.productPercent)) с товаров") }
        guard !parts.isEmpty else { return "Ничего не начисляется" }
        if rules.deductMaterials { parts.append("минус расходники") }
        return parts.joined(separator: " · ")
    }

    /// «с 1 октября 2026».
    static func effectiveFrom(_ date: String) -> String {
        guard let day = CalendarDay.date(from: date) else { return date }
        return "с " + DateText.fullDate(day)
    }

    /// «15 октября» for line and adjustment dates.
    static func day(_ date: String) -> String {
        CalendarDay.date(from: date).map(DateText.dayMonth) ?? date
    }
}
