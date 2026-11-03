import SwiftUI

/// How an employee is paid: the rules in force today and every version with its start date. The owner edits them.
struct PayRulesView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppState.self) private var appState

    let employee: EmployeeRef
    @State private var rules = Remote<PayRulesResponse>()
    @State private var editing = false

    private var canEdit: Bool { appState.employee?.role == .owner }

    var body: some View {
        List {
            if let value = rules.value {
                currentSection(value)
                if !value.history.isEmpty {
                    historySection(value.history)
                }
            }
        }
        .overlay {
            RemoteStateOverlay(remote: rules, retry: load)
        }
        .auraBackground()
        .refreshable { await load() }
        .task { await load() }
        .remoteErrorAlert(rules)
        .navigationTitle("Правила зарплаты")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if canEdit, rules.value != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Изменить") { editing = true }
                }
            }
        }
        .sheet(isPresented: $editing) {
            if let value = rules.value {
                PayRulesEditorView(employee: employee, response: value) { saved in rules.set(saved) }
            }
        }
    }

    @ViewBuilder
    private func currentSection(_ value: PayRulesResponse) -> some View {
        Section {
            if let current = value.current {
                PayRulesDetails(rules: current)
            } else {
                Text(value.history.isEmpty ? "Правила ещё не заданы — зарплата не начисляется." : "Правила начнут действовать позже.")
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text(employee.name)
        } footer: {
            if canEdit, value.current == nil {
                Text("Нажмите «Изменить», чтобы задать оклад, оплату за день и проценты.")
            }
        }
    }

    private func historySection(_ history: [PayRulesVersion]) -> some View {
        Section("История") {
            ForEach(history) { version in
                VStack(alignment: .leading, spacing: 4) {
                    Text(PayrollText.effectiveFrom(version.effectiveFrom).capitalizedFirst)
                        .font(.subheadline.weight(.semibold))
                    Text(PayrollText.rulesSummary(version.rules))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let author = version.createdBy {
                        Text("Изменено: \(author.name), \(DateText.dateTime(version.createdAt))")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private func load() async {
        await rules.load { try await api.payRules(employeeId: employee.id) }
    }
}

/// The fields of one rules version, one per row.
private struct PayRulesDetails: View {
    let rules: PayRules

    var body: some View {
        LabeledContent("Оклад в месяц", value: Money.format(rules.salaryMonthly))
        LabeledContent("За рабочий день", value: Money.format(rules.perDay))
        LabeledContent("Процент с услуг", value: PayrollText.percent(rules.servicePercent))
        ForEach(ServiceCategory.allCases) { category in
            if let percent = rules.categoryPercent[category] {
                LabeledContent("— \(category.title)", value: PayrollText.percent(percent))
            }
        }
        LabeledContent("Процент с товаров", value: PayrollText.percent(rules.productPercent))
        LabeledContent("Вычитать расходники", value: rules.deductMaterials ? "Да" : "Нет")
    }
}

private extension String {
    /// «с 1 октября» → «С 1 октября».
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

#if DEBUG
#Preview {
    NavigationStack {
        PayRulesView(employee: PreviewData.anna.ref)
    }
    .previewEnvironment()
}
#endif
