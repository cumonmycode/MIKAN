import SwiftUI

/// «Сегодня» above the period: what was earned today. It loads apart from the period, so its failure never blocks
/// the screen: a quiet retry line, no alert.
struct PayrollTodayCard: View {
    let today: Remote<PayrollList>
    /// Whose day: `nil` for the whole studio (the owner's list), else the employee's own.
    let employeeId: Int?
    /// Switches the period to «Сегодня» for the full statement.
    let onDetails: () -> Void
    let retry: () async -> Void

    var body: some View {
        let summary = today.value.map { PayrollTodaySummary($0.items) }
        VStack(alignment: .leading, spacing: 12) {
            header(hasDetails: summary.map(hasData) ?? false)
            if let summary {
                content(summary)
            } else if today.failure != nil {
                failureLine
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .cardStyle()
    }

    private func header(hasDetails: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(PayrollTodaySummary.range().title())
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            if hasDetails {
                Button("Подробнее", action: onDetails).font(.subheadline)
            }
        }
    }

    @ViewBuilder
    private func content(_ summary: PayrollTodaySummary) -> some View {
        if let employeeId {
            if let own = summary.statement(of: employeeId) {
                PayrollTodayOwn(statement: own)
            } else {
                emptyLine
            }
        } else if summary.isEmpty {
            emptyLine
        } else {
            PayrollTodayTeam(summary: summary)
        }
    }

    private func hasData(_ summary: PayrollTodaySummary) -> Bool {
        employeeId.map { summary.statement(of: $0) != nil } ?? !summary.isEmpty
    }

    private var emptyLine: some View {
        Text("Сегодня начислений пока нет").font(.subheadline).foregroundStyle(.secondary)
    }

    private var failureLine: some View {
        HStack(spacing: 8) {
            Text("Не удалось загрузить").font(.subheadline).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Button("Повторить") { Task { await retry() } }.font(.subheadline)
        }
    }
}

/// The total of the day in large type with a caption next to it.
private struct PayrollTodayTotal: View {
    let amount: Int
    let caption: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            MoneyText(amount).font(.title.weight(.bold))
            Text(caption).font(.subheadline).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The employee's own day: the total and what it is made of.
private struct PayrollTodayOwn: View {
    let statement: PayrollStatement

    var body: some View {
        PayrollTodayTotal(amount: statement.earned, caption: "начислено")
        HStack(spacing: 16) {
            PayrollLabeledValue(title: "Услуги", value: Money.format(statement.services.amount))
            PayrollLabeledValue(title: "Товары", value: Money.format(statement.products.amount))
            PayrollLabeledValue(title: "Визиты", value: String(statement.services.visits))
        }
        .accessibilityElement(children: .combine)
    }
}

/// The studio's day: the total, then a line per employee who earned something; a line opens their day.
private struct PayrollTodayTeam: View {
    let summary: PayrollTodaySummary

    private var caption: String {
        summary.visits > 0 ? "начислено · \(PayrollText.visits(summary.visits))" : "начислено"
    }

    var body: some View {
        PayrollTodayTotal(amount: summary.earned, caption: caption)
        Divider()
        ForEach(summary.statements) { statement in
            NavigationLink {
                PayrollStatementView(employee: statement.employee, selection: PayrollPeriodSelection(option: .today))
            } label: {
                PayrollTodayRow(statement: statement)
            }
            .buttonStyle(.plain)
        }
    }
}

/// One employee's day in the owner's card: name, visits and what they earned.
private struct PayrollTodayRow: View {
    let statement: PayrollStatement

    var body: some View {
        HStack(spacing: 10) {
            InitialsAvatar(name: statement.employee.name, color: .master(statement.employee.color), size: 30)
            VStack(alignment: .leading, spacing: 1) {
                Text(statement.employee.name).font(.subheadline.weight(.semibold))
                if statement.services.visits > 0 {
                    Text(PayrollText.visits(statement.services.visits)).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            MoneyText(statement.earned)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(statement.earned < 0 ? Color.red : Color.primary)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

extension Remote where Value == PayrollList {
    /// Today's statements (the owner gets everyone, anyone else only themselves). A new day starts from scratch, so
    /// yesterday's numbers never stay up as today's.
    func loadToday(api: APIClient, now: Date = .now) async {
        let day = PayrollTodaySummary.range(now: now)
        if value?.from != day.from { reset() }
        await load { try await api.payroll(from: day.from, to: day.to) }
    }
}
