import SwiftUI

/// «Расходы студии»: rent, bills and one-time purchases charged in the period, by category and by expense.
struct AnalyticsExpensesCard: View {
    let expenses: AnalyticsExpenses
    let previousTotal: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            AnalyticsCardTitle(title: "Расходы студии", systemImage: "creditcard", caption: "Аренда, счета и разовые покупки")
            if expenses.total == 0 {
                AnalyticsHint(text: "За период расходов нет. Аренду, свет и покупки добавляют в «Ещё» → «Расходы студии».")
            } else {
                AnalyticsMoneyRow(title: "Каждый месяц", amount: expenses.monthly)
                AnalyticsMoneyRow(title: "Разовые", amount: expenses.once)
                Divider()
                AnalyticsMoneyRow(title: "Итого", amount: expenses.total, detail: "было \(Money.format(previousTotal))", isEmphasized: true)
                if expenses.byCategory.count > 1 {
                    Divider()
                    ForEach(expenses.byCategory) { category in
                        AnalyticsMoneyRow(title: category.category.title, amount: category.amount)
                    }
                }
                AnalyticsTopList(items: expenses.items, collapsedCount: 3) { index, item in
                    HStack(alignment: .firstTextBaseline) {
                        AnalyticsRank(index: index)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.name).font(.subheadline)
                            Text(line(item))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        MoneyText(item.amount).font(.subheadline.weight(.semibold))
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .cardStyle()
    }

    /// «Аренда · каждый месяц × 2», «Мебель и оборудование · разовый».
    private func line(_ item: AnalyticsExpenses.Item) -> String {
        let repeatText = switch item.repeatKind {
        case .monthly: item.times > 1 ? "каждый месяц × \(item.times)" : "каждый месяц"
        case .once: "разовый"
        }
        return "\(item.category.title) · \(repeatText)"
    }
}
