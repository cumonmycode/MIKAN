import SwiftUI

/// «Начислить или списать»: a manual bonus adjustment with a note (owner and admin; `POST /clients/:id/bonuses`).
/// Added bonuses may burn on a chosen day; taking never goes below the balance.
struct BonusAdjustSheet: View {
    enum Direction: Hashable, CaseIterable {
        case add
        case take

        var title: String { self == .add ? "Начислить" : "Списать" }
    }

    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    let clientId: Int
    let balance: Int
    let onSaved: () -> Void

    @State private var direction = Direction.add
    @State private var amount = 0
    @State private var note = ""
    @State private var burns = false
    @State private var burnsOn = Calendar.app.date(byAdding: .month, value: 1, to: .now) ?? .now
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var signedAmount: Int { direction == .add ? amount : -amount }
    private var isValid: Bool { BonusLedger.isValidAdjustment(amount: signedAmount, note: note, balance: balance) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Действие", selection: $direction) {
                        ForEach(Direction.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                Section {
                    NumberField.integer("Бонусов", value: $amount)
                } footer: {
                    Text(amountFooter).monospacedDigit()
                }
                Section {
                    TextField("Например, компенсация за ожидание", text: $note, axis: .vertical)
                        .lineLimit(2...4)
                } header: {
                    Text("Комментарий")
                } footer: {
                    Text("Обязательно: коллеги увидят причину в истории бонусов.")
                }
                if direction == .add {
                    Section {
                        Toggle("Сгорают", isOn: $burns.animation())
                        if burns {
                            DatePicker("Последний день", selection: $burnsOn, in: Date.now..., displayedComponents: .date)
                        }
                    } footer: {
                        Text(burns ? "Неиспользованные бонусы сгорят после этого дня." : "Без срока — бонусы не сгорят.")
                    }
                }
            }
            .navigationTitle("Бонусы")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Сохранить", action: save).disabled(!isValid)
                    }
                }
            }
            .errorAlert($errorMessage, title: "Бонусы не изменены")
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(isSaving)
    }

    private var amountFooter: String {
        let current = "На счёте \(BonusText.count(balance))."
        if direction == .take, amount > balance {
            return "\(current) Больше списать нельзя."
        }
        guard amount > 0 else { return current }
        return "\(current) Станет \(BonusText.count(balance + signedAmount))."
    }

    private func save() {
        let body = BonusAdjustBody(
            amount: signedAmount,
            note: note.trimmed,
            expiresAt: direction == .add && burns ? BonusAdjustDates.endOfDay(burnsOn) : nil
        )
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                _ = try await api.adjustBonuses(clientId: clientId, body)
                onSaved()
                dismiss()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

nonisolated enum BonusAdjustDates {
    /// The instant a lot whose last day is `day` burns: the start of the next day (studio calendar).
    static func endOfDay(_ day: Date, calendar: Calendar = .app) -> Date {
        let start = calendar.startOfDay(for: day)
        return calendar.date(byAdding: .day, value: 1, to: start) ?? start
    }
}

#if DEBUG
#Preview {
    BonusAdjustSheet(clientId: 1, balance: 1_200) {}
        .previewEnvironment()
}
#endif
