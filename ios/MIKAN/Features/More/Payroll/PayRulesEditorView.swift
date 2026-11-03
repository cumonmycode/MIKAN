import SwiftUI

/// The owner sets how an employee is paid from a date on; earlier days keep the rules they had.
struct PayRulesEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api

    let employee: EmployeeRef
    let history: [PayRulesVersion]
    let onSaved: (PayRulesResponse) -> Void

    @State private var draft: PayRulesDraft
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(employee: EmployeeRef, response: PayRulesResponse, onSaved: @escaping (PayRulesResponse) -> Void) {
        self.employee = employee
        self.history = response.history
        self.onSaved = onSaved
        // Start from the rules in force (else the planned ones), effective today.
        _draft = State(initialValue: PayRulesDraft(rules: response.current ?? response.history.first?.rules, effectiveFrom: .now))
    }

    private var canSave: Bool { draft.problem == nil && !isSaving }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("Действуют с", selection: $draft.effectiveFrom, displayedComponents: .date)
                } footer: {
                    Text(draft.dateHint(history: history))
                }
                Section {
                    NumberField.money("Оклад в месяц", value: $draft.salaryMonthly)
                    NumberField.money("За рабочий день", value: $draft.perDay)
                } header: {
                    Text("Фиксированная часть")
                } footer: {
                    Text("Оклад делится на дни месяца: за неполный месяц — его часть. За рабочий день — за каждый день с завершённой записью или продажей.")
                }
                Section {
                    NumberField.integer("Процент с услуг", value: $draft.servicePercent, unit: "%")
                    ForEach(ServiceCategory.allCases) { category in
                        // Empty shows the general percent greyed out: that is what the category gets.
                        NumberField(
                            title: "— \(category.title)", value: categoryBinding(category), suffix: "%",
                            groupsDigits: false, placeholder: String(draft.servicePercent)
                        )
                    }
                    Toggle("Вычитать расходники", isOn: $draft.deductMaterials)
                } header: {
                    Text("Услуги")
                } footer: {
                    Text("Процент с выручки завершённых записей мастера после скидки. Пустой раздел — общий процент. Расходники, списанные на запись, вычитаются из её выручки до процента.")
                }
                Section {
                    NumberField.integer("Процент с товаров", value: $draft.productPercent, unit: "%")
                } header: {
                    Text("Товары")
                } footer: {
                    Text("С украшений и товаров: проданных на записи мастера — ему, без записи — тому, кто провёл продажу.")
                }
                if let problem = draft.problem {
                    Section {
                        Text(problem).foregroundStyle(.red)
                    }
                }
            }
            .disabled(isSaving)
            .navigationTitle(employee.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving { ProgressView() } else { Button("Сохранить", action: save).disabled(!canSave) }
                }
            }
            .interactiveDismissDisabled(isSaving)
            .errorAlert($errorMessage)
        }
    }

    private func categoryBinding(_ category: ServiceCategory) -> Binding<Int?> {
        Binding(get: { draft.categoryPercents[category] }, set: { draft.categoryPercents[category] = $0 })
    }

    private func save() {
        let body = draft.body()
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                onSaved(try await api.savePayRules(employeeId: employee.id, body))
                dismiss()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    PayRulesEditorView(employee: PreviewData.anna.ref, response: PayRulesResponse(current: nil, history: [])) { _ in }
        .previewEnvironment()
}
#endif
