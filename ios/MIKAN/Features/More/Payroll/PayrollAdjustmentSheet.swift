import SwiftUI

/// The owner adds a bonus, a penalty, an advance or a payout; an advance or payout may be taken from the till.
struct PayrollAdjustmentSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api

    let employee: EmployeeRef
    let onSaved: (PayrollAdjustment) -> Void

    @State private var draft = PayrollAdjustmentDraft()
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var retryMessage: String?
    @State private var saveKey = IdempotencyKey()

    private var canSave: Bool { draft.problem == nil && !isSaving }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Что", selection: $draft.kind) {
                        ForEach(PayrollAdjustmentKind.allCases) { kind in
                            Label(kind.title, systemImage: kind.systemImage).tag(kind)
                        }
                    }
                    NumberField.money("Сумма", value: $draft.amount)
                    DatePicker("Дата", selection: $draft.date, displayedComponents: .date)
                } footer: {
                    Text(draft.kindHint)
                }
                if draft.canPayFromCash {
                    Section {
                        Toggle("Выдать из кассы", isOn: $draft.fromCash)
                    } footer: {
                        Text(draft.fromCash
                            ? draft.cashHint(employeeName: employee.name)
                            : "Включите, если деньги выдаёте наличными из кассы сейчас — нужна открытая смена.")
                    }
                }
                Section("Комментарий") {
                    TextField("Например, за отзывы", text: $draft.note, axis: .vertical)
                        .lineLimit(1...3)
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
            .retryAlert($retryMessage, title: "Запись могла сохраниться", retry: save)
        }
        .presentationDetents([.large])
    }

    private func save() {
        let body = draft.body(employeeId: employee.id)
        let key = saveKey.key(for: body)
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let saved = try await api.addPayrollAdjustment(body, idempotencyKey: key)
                saveKey.reset()
                onSaved(saved)
                dismiss()
            } catch let error as APIError where error.isOutcomeUnknown {
                retryMessage = "Связь прервалась до ответа сервера. Нажмите «Повторить» — если запись уже сохранена, второй раз она не появится."
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    PayrollAdjustmentSheet(employee: PreviewData.anna.ref) { _ in }
        .previewEnvironment()
}
#endif
