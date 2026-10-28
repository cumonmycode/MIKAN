import SwiftUI

/// «Удержать»: how much of the held prepayment the studio keeps (pre-filled by the studio's rules) and why.
struct DepositRetainSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api

    let appointment: Appointment
    let onRetained: (Appointment) -> Void

    @State private var amount: Int
    @State private var reason: String
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var retryMessage: String?
    @State private var retainKey = IdempotencyKey()

    init(appointment: Appointment, amount: Int, onRetained: @escaping (Appointment) -> Void) {
        self.appointment = appointment
        self.onRetained = onRetained
        _amount = State(initialValue: amount)
        _reason = State(initialValue: DepositRules.retainReason(appointment))
    }

    private var held: Int { appointment.deposit }
    private var amountMessage: String? { DepositRetainRules.amountMessage(amount, held: held) }
    private var canSave: Bool { amountMessage == nil && !isSaving }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    NumberField.money("Сумма", value: $amount)
                } footer: {
                    if let amountMessage {
                        Text(amountMessage).foregroundStyle(.red)
                    } else {
                        Text(DepositRetainRules.footer(amount: amount, held: held)).monospacedDigit()
                    }
                }
                Section("Причина") {
                    TextField("Необязательно", text: $reason, axis: .vertical)
                        .lineLimit(1...3)
                }
            }
            .disabled(isSaving)
            .navigationTitle("Удержание")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving { ProgressView() } else { Button("Удержать", action: save).disabled(!canSave) }
                }
            }
            .interactiveDismissDisabled(isSaving)
            .errorAlert($errorMessage)
            .retryAlert($retryMessage, title: "Удержание могло пройти", retry: save)
        }
        .presentationDetents([.medium, .large])
    }

    private func save() {
        let body = DepositRetainBody(amount: amount, reason: reason.trimmed.nonEmpty ?? DepositText.retainReason(for: appointment.status))
        let key = retainKey.key(for: body)
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let updated = try await api.retainDeposit(appointmentId: appointment.id, body, idempotencyKey: key)
                retainKey.reset()
                onRetained(updated)
                dismiss()
            } catch let error as APIError where error.isOutcomeUnknown {
                retryMessage = "Связь прервалась до ответа сервера. Нажмите «Повторить» — если предоплата уже удержана, второй раз это не запишется."
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

/// Validation and hints of the retain sheet.
enum DepositRetainRules {
    static func amountMessage(_ amount: Int, held: Int) -> String? {
        if amount <= 0 { return "Укажите сумму." }
        if amount > held { return "Не больше внесённой суммы (\(Money.format(held)))." }
        return nil
    }

    /// «Деньги останутся у студии. Остаток 1 000 ₽ останется за записью — его можно вернуть клиенту.»
    static func footer(amount: Int, held: Int) -> String {
        let rest = held - amount
        guard rest > 0 else { return "Деньги останутся у студии, клиенту они не вернутся. Внесено за запись: \(Money.format(held))." }
        return "Деньги останутся у студии. Остаток \(Money.format(rest)) останется за записью — его можно вернуть клиенту."
    }
}

#if DEBUG
#Preview {
    DepositRetainSheet(appointment: PreviewData.appointments[0], amount: 1000) { _ in }
        .previewEnvironment()
}
#endif
