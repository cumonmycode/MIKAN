import SwiftUI

/// The cards of a loaded statement: what is due, what it is made of, adjustments, and every line.
struct PayrollStatementContent: View {
    let statement: PayrollStatement
    let canManage: Bool
    let onAdd: () -> Void
    let onDelete: (PayrollAdjustment) -> Void

    private var adjustments: [PayrollAdjustment] { statement.adjustmentItems ?? [] }
    private var lines: [PayrollLine] { statement.lines ?? [] }

    var body: some View {
        PayrollDueCard(statement: statement)
        PayrollEarnedCard(statement: statement)
        if !adjustments.isEmpty || canManage {
            PayrollAdjustmentsCard(adjustments: adjustments, canManage: canManage, onAdd: onAdd, onDelete: onDelete)
        }
        if !lines.isEmpty {
            PayrollLinesCard(lines: lines)
        }
    }
}

/// «К выплате» in large type with what was earned and paid.
private struct PayrollDueCard: View {
    let statement: PayrollStatement

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(PayrollText.dueTitle(statement.due))
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            MoneyText(abs(statement.due))
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(statement.due < 0 ? Color.orange : Color.primary)
            HStack(spacing: 16) {
                PayrollLabeledValue(title: "Начислено", value: Money.format(statement.earned))
                PayrollLabeledValue(title: "Выплачено", value: Money.format(statement.paid))
            }
        }
        .cardStyle()
        .accessibilityElement(children: .combine)
    }
}

/// A small caption over a value, side by side in the due and today cards.
struct PayrollLabeledValue: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.headline).monospacedDigit()
        }
    }
}

/// A row of a breakdown: title with an explanation and an amount on the right.
private struct PayrollAmountRow: View {
    let title: String
    var detail: String?
    let amount: String
    var tint: Color = .primary

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
            }
            Spacer(minLength: 8)
            Text(amount).monospacedDigit().foregroundStyle(tint)
        }
        .accessibilityElement(children: .combine)
    }
}

/// What the pay is made of: percents, salary, per-day pay, bonuses and penalties, and what was paid out.
private struct PayrollEarnedCard: View {
    let statement: PayrollStatement

    private var services: PayrollStatement.Services { statement.services }
    private var totals: PayrollStatement.AdjustmentTotals { statement.adjustments }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Начислено").font(.headline)
            if statement.earned == 0 && totals.penalty == 0 && services.visits == 0 {
                Text("За этот период пока ничего не начислено.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if services.visits > 0 || services.amount > 0 {
                PayrollAmountRow(title: "Услуги", detail: servicesDetail, amount: Money.format(services.amount))
            }
            if statement.products.revenue > 0 || statement.products.amount > 0 {
                PayrollAmountRow(
                    title: "Товары",
                    detail: "Продажи \(Money.format(statement.products.revenue))",
                    amount: Money.format(statement.products.amount)
                )
            }
            if statement.salary > 0 {
                PayrollAmountRow(title: "Оклад", detail: "За дни периода", amount: Money.format(statement.salary))
            }
            if statement.days > 0 || statement.perDay > 0 {
                PayrollAmountRow(title: "За рабочие дни", detail: Plural.days(statement.days), amount: Money.format(statement.perDay))
            }
            if totals.bonus > 0 {
                PayrollAmountRow(title: "Премии", amount: Money.formatSigned(totals.bonus), tint: .green)
            }
            if totals.penalty > 0 {
                PayrollAmountRow(title: "Штрафы", amount: Money.formatSigned(-totals.penalty), tint: .red)
            }
            Divider()
            PayrollAmountRow(title: "Итого", amount: Money.format(statement.earned))
                .font(.headline)
            if statement.paid > 0 {
                PayrollAmountRow(title: "Авансы", amount: Money.format(totals.advance))
                PayrollAmountRow(title: "Выплаты", amount: Money.format(totals.payout))
            }
        }
        .cardStyle()
    }

    /// «12 визитов · выручка 84 000 ₽ · расходники 2 100 ₽».
    private var servicesDetail: String {
        var parts = [PayrollText.visits(services.visits), "выручка \(Money.format(services.revenue))"]
        if services.materials > 0 { parts.append("расходники \(Money.format(services.materials))") }
        return parts.joined(separator: " · ")
    }
}

/// Bonuses, penalties, advances and payouts of the period; the owner adds and deletes them.
private struct PayrollAdjustmentsCard: View {
    let adjustments: [PayrollAdjustment]
    let canManage: Bool
    let onAdd: () -> Void
    let onDelete: (PayrollAdjustment) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Премии, штрафы и выплаты").font(.headline)
            if adjustments.isEmpty {
                Text("Пока ничего не добавлено.").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(adjustments) { adjustment in
                row(adjustment)
            }
            if canManage {
                Button("Добавить", systemImage: "plus.circle.fill", action: onAdd)
                    .font(.subheadline.weight(.semibold))
            }
        }
        .cardStyle()
    }

    private func row(_ adjustment: PayrollAdjustment) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: adjustment.kind.systemImage)
                .foregroundStyle(tint(adjustment.kind))
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(adjustment.kind.title)
                Text(detail(adjustment)).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Text(PayrollText.adjustmentAmount(adjustment)).monospacedDigit().foregroundStyle(tint(adjustment.kind))
            if canManage {
                Menu {
                    Button("Удалить", systemImage: "trash", role: .destructive) { onDelete(adjustment) }
                } label: {
                    Image(systemName: "ellipsis.circle").foregroundStyle(.secondary)
                }
                .accessibilityLabel("Действия: \(adjustment.kind.title)")
            }
        }
    }

    /// «15 октября · из кассы · За отзывы».
    private func detail(_ adjustment: PayrollAdjustment) -> String {
        var parts = [PayrollText.day(adjustment.date)]
        if adjustment.cashOperationId != nil { parts.append("из кассы") }
        if let note = adjustment.note.nonEmpty { parts.append(note) }
        return parts.joined(separator: " · ")
    }

    private func tint(_ kind: PayrollAdjustmentKind) -> Color {
        switch kind {
        case .bonus: .green
        case .penalty: .red
        case .advance, .payout: .primary
        }
    }
}

/// Every service and product line the percents came from, by day.
private struct PayrollLinesCard: View {
    let lines: [PayrollLine]

    private var days: [(date: String, lines: [PayrollLine])] {
        Dictionary(grouping: lines, by: \.date)
            .map { (date: $0.key, lines: $0.value) }
            .sorted { $0.date < $1.date }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Из чего сложились проценты").font(.headline)
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(days, id: \.date) { day in
                    Text(PayrollText.day(day.date))
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ForEach(Array(day.lines.enumerated()), id: \.offset) { _, line in
                        lineRow(line)
                    }
                }
            }
        }
        .cardStyle()
    }

    private func lineRow(_ line: PayrollLine) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(line.name).lineLimit(2)
                    StatusBadge(text: PayrollText.lineKind(line), color: line.isService ? .accentColor : .teal)
                }
                Text(PayrollText.lineFormula(line)).font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            Spacer(minLength: 8)
            MoneyText(line.amount).font(.subheadline.weight(.semibold))
        }
        .accessibilityElement(children: .combine)
    }
}
