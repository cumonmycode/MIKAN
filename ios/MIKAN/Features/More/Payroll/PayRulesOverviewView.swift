import SwiftUI

/// «Правила зарплаты» for the owner: how everyone is paid at a glance, the quick «доля мастера» setup for several
/// masters at once, and each employee's full rules (salary, per day, categories, history) one tap away.
struct PayRulesOverviewView: View {
    @Environment(APIClient.self) private var api
    @State private var rows = Remote<[PayRulesOverviewRow]>()
    @State private var setsUp = false

    var body: some View {
        List {
            Section {
                Button { setsUp = true } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Быстрая настройка").font(.headline)
                            Text("Доля мастера с услуг — например, 60 на 40 — для всех мастеров сразу")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "percent")
                    }
                }
                .disabled(rows.value == nil)
            } footer: {
                Text("Процент считается с выручки за услуги мастера — после скидки, без оплаты бонусами. Оклад, оплату за рабочий день и свой процент для тату или пирсинга задайте в правилах сотрудника.")
            }
            if let value = rows.value {
                Section("Сотрудники") {
                    ForEach(value) { row in
                        NavigationLink {
                            PayRulesView(employee: row.employee.ref)
                        } label: {
                            PayRulesOverviewRowView(row: row)
                        }
                    }
                }
            }
        }
        .overlay {
            RemoteStateOverlay(remote: rows, retry: load)
        }
        .auraBackground()
        .refreshable { await load() }
        .task { await load() }
        .remoteErrorAlert(rows)
        .navigationTitle("Правила зарплаты")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $setsUp) {
            if let value = rows.value {
                PayRulesQuickSetupSheet(rows: value) {
                    Task { await load() }
                }
            }
        }
    }

    private func load() async {
        await rows.load {
            let employees = try await api.employees()
            var loaded: [PayRulesOverviewRow] = []
            for employee in employees {
                let rules = try await api.payRules(employeeId: employee.id)
                loaded.append(PayRulesOverviewRow(employee: employee, rules: rules.current))
            }
            return PayRulesOverviewRow.sorted(loaded)
        }
    }
}

/// One employee: the rules in force today in one line, or «Не настроены».
private struct PayRulesOverviewRowView: View {
    let row: PayRulesOverviewRow

    var body: some View {
        HStack(spacing: 12) {
            InitialsAvatar(name: row.employee.name, color: .master(row.employee.color), size: 40)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.employee.name).font(.headline)
                if let rules = row.rules {
                    Text(PayrollText.rulesSummary(rules))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Не настроены — зарплата не начисляется")
                        .font(.subheadline)
                        .foregroundStyle(.orange)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        PayRulesOverviewView()
    }
    .previewEnvironment()
}
#endif
