import SwiftUI

/// «Зарплата» (Ещё): the owner sees everyone's statements for the period; anyone else goes straight to their own.
struct PayrollView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        if let employee = appState.employee {
            if employee.role == .owner {
                PayrollListView()
            } else {
                PayrollStatementView(employee: employee.ref, selection: PayrollPeriodSelection())
            }
        } else {
            ContentUnavailableView("Нет данных о сотруднике", systemImage: "person.crop.circle.badge.questionmark")
        }
    }
}

/// The owner's list: one card per employee with rules or activity in the period, and the period totals.
private struct PayrollListView: View {
    @Environment(APIClient.self) private var api
    @State private var selection = PayrollPeriodSelection()
    @State private var list = Remote<PayrollList>()
    /// The period on screen. The task runs again whenever the screen reappears (a swipe back from a statement): the
    /// rows are cleared only for another period, otherwise they stay while the list quietly refreshes.
    @State private var shownRange: PayrollRange?
    /// «Сегодня» card, loaded apart from the period.
    @State private var today = Remote<PayrollList>()

    private var range: PayrollRange { selection.range() }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                PayrollPeriodHeader(selection: $selection)
                if selection.option != .today {
                    PayrollTodayCard(today: today, employeeId: nil, onDetails: showToday, retry: loadToday)
                }
                if let value = list.value {
                    content(value.items)
                } else if let failure = list.failure {
                    ErrorStateView(message: failure, retry: load)
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 240)
                }
            }
            .padding(16)
        }
        .background { AuraBackground() }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .refreshable {
            async let day: Void = loadToday()
            await load()
            await day
        }
        .task(id: range) {
            if shownRange != range { list.reset() }
            shownRange = range
            await load()
        }
        .task { await loadToday() }
        .remoteErrorAlert(list)
        .navigationTitle("Зарплата")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    PayRulesOverviewView()
                } label: {
                    Label("Правила", systemImage: "slider.horizontal.3")
                }
            }
        }
    }

    @ViewBuilder
    private func content(_ items: [PayrollStatement]) -> some View {
        if items.isEmpty {
            ContentUnavailableView {
                Label("Начислений нет", systemImage: "banknote")
            } description: {
                Text("Задайте, как платить мастерам — например, 60 на 40, — и зарплата посчитается сама.")
            } actions: {
                NavigationLink {
                    PayRulesOverviewView()
                } label: {
                    Text("Настроить зарплату")
                }
                .buttonStyle(.borderedProminent)
            }
        } else {
            rulesHint
            totals(items)
            ForEach(items) { statement in
                NavigationLink {
                    PayrollStatementView(employee: statement.employee, selection: selection)
                } label: {
                    PayrollEmployeeRow(statement: statement)
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Above the list: where the rules live, so the owner never has to look for them in the employee cards.
    private var rulesHint: some View {
        NavigationLink {
            PayRulesOverviewView()
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "slider.horizontal.3").foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Правила зарплаты").font(.subheadline.weight(.semibold))
                    Text("Доля мастера, оклад, оплата за день").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .cardStyle(padding: 14)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private func totals(_ items: [PayrollStatement]) -> some View {
        let due = items.reduce(0) { $0 + max(0, $1.due) }
        return HStack(spacing: 12) {
            StatTile(title: "Начислено", value: Money.format(items.reduce(0) { $0 + $1.earned }), systemImage: "sum")
            StatTile(title: "Выплачено", value: Money.format(items.reduce(0) { $0 + $1.paid }), systemImage: "banknote")
            StatTile(title: "К выплате", value: Money.format(due), systemImage: "hourglass", tint: .orange)
        }
    }

    private func load() async {
        let range = range
        await list.load { try await api.payroll(from: range.from, to: range.to) }
    }

    private func loadToday() async {
        await today.loadToday(api: api)
    }

    private func showToday() {
        withAnimation(.snappy) { selection.option = .today }
    }
}

/// One employee in the owner's list: what was earned, paid and is still due.
private struct PayrollEmployeeRow: View {
    let statement: PayrollStatement

    var body: some View {
        HStack(spacing: 12) {
            InitialsAvatar(name: statement.employee.name, color: .master(statement.employee.color), size: 44)
            VStack(alignment: .leading, spacing: 4) {
                Text(statement.employee.name).font(.headline)
                Text("Начислено \(Money.format(statement.earned)) · выплачено \(Money.format(statement.paid))")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(PayrollText.dueTitle(statement.due)).font(.caption).foregroundStyle(.secondary)
                MoneyText(abs(statement.due))
                    .font(.headline)
                    .foregroundStyle(statement.due < 0 ? Color.orange : Color.primary)
            }
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .cardStyle(padding: 14)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        PayrollView()
    }
    .previewEnvironment()
}
#endif
