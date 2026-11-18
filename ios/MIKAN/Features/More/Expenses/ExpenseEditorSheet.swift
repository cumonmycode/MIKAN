import SwiftUI

/// Adds or edits a studio expense: a monthly bill (rent, electricity) or a one-time purchase.
struct ExpenseEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api

    /// `nil` — a new expense.
    let expense: StudioExpense?
    let onSaved: (StudioExpense) -> Void
    var onDeleted: ((Int) -> Void)?

    @State private var draft: ExpenseDraft
    @State private var isSaving = false
    @State private var confirmsDelete = false
    @State private var errorMessage: String?
    @State private var retryMessage: String?
    @State private var saveKey = IdempotencyKey()

    init(expense: StudioExpense?, newRepeat: ExpenseRepeat = .monthly, onSaved: @escaping (StudioExpense) -> Void,
         onDeleted: ((Int) -> Void)? = nil) {
        self.expense = expense
        self.onSaved = onSaved
        self.onDeleted = onDeleted
        _draft = State(initialValue: expense.map { ExpenseDraft($0) } ?? ExpenseDraft(repeatKind: newRepeat))
    }

    private var problem: String? { draft.problem() }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Как платим", selection: $draft.repeatKind.animation(.snappy)) {
                        ForEach(ExpenseRepeat.allCases) { kind in
                            Text(kind.title).tag(kind)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                Section {
                    TextField(draft.repeatKind == .monthly ? "Например, аренда помещения" : "Например, шкаф для расходников",
                              text: $draft.name)
                    Picker("Категория", selection: $draft.category) {
                        ForEach(ExpenseCategory.allCases) { category in
                            Label(category.title, systemImage: category.systemImage).tag(category)
                        }
                    }
                    NumberField.money(draft.repeatKind == .monthly ? "В месяц" : "Сумма", value: $draft.amount)
                }
                Section {
                    DatePicker(draft.repeatKind == .monthly ? "С какого числа" : "Дата покупки",
                               selection: $draft.date, displayedComponents: .date)
                    if draft.repeatKind == .monthly {
                        Toggle("Закончился", isOn: $draft.hasEndDate.animation(.snappy))
                        if draft.hasEndDate {
                            DatePicker("Последний платёж", selection: $draft.endDate, in: draft.date..., displayedComponents: .date)
                        }
                    }
                } footer: {
                    Text(draft.repeatKind == .monthly && draft.hasEndDate
                        ? "После этой даты расход перестанет попадать в отчёты, прошлые месяцы останутся."
                        : draft.dateHint())
                }
                Section("Комментарий") {
                    TextField("Необязательно", text: $draft.note, axis: .vertical)
                        .lineLimit(1...3)
                }
                if expense != nil {
                    Section {
                        Button("Удалить расход", role: .destructive) { confirmsDelete = true }
                    } footer: {
                        Text("Расход пропадёт из отчётов за все периоды. Если аренда просто закончилась, включите «Закончился».")
                    }
                }
            }
            .disabled(isSaving)
            .navigationTitle(expense == nil ? "Новый расход" : "Расход")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Сохранить", action: save).disabled(problem != nil)
                    }
                }
            }
            .confirmationDialog("Удалить «\(expense?.name ?? "")»?", isPresented: $confirmsDelete, titleVisibility: .visible) {
                Button("Удалить", role: .destructive, action: delete)
                Button("Оставить", role: .cancel) {}
            }
            .interactiveDismissDisabled(isSaving)
            .errorAlert($errorMessage)
            .retryAlert($retryMessage, title: "Расход мог сохраниться", retry: save)
        }
        .presentationDetents([.large])
    }

    private func save() {
        let body = draft.body()
        let key = saveKey.key(for: body)
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let saved: StudioExpense
                if let expense {
                    saved = try await api.updateExpense(id: expense.id, body)
                } else {
                    saved = try await api.addExpense(body, idempotencyKey: key)
                    saveKey.reset()
                }
                onSaved(saved)
                dismiss()
            } catch let error as APIError where error.isOutcomeUnknown && expense == nil {
                retryMessage = "Связь прервалась до ответа сервера. Нажмите «Повторить» — если расход уже сохранён, второй раз он не появится."
            } catch {
                errorMessage = error.userMessage
            }
        }
    }

    private func delete() {
        guard let expense else { return }
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                try await api.deleteExpense(id: expense.id)
                onDeleted?(expense.id)
                dismiss()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    ExpenseEditorSheet(expense: nil) { _ in }
        .previewEnvironment()
}
#endif
