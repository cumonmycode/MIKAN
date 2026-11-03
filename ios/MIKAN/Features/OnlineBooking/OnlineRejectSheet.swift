import SwiftUI

/// «Отклонить онлайн-запись»: an optional reason for the client, then `…/online/reject`.
struct OnlineRejectSheet: View {
    static let quickReasons = [
        "Мастер не сможет в это время",
        "Нужна консультация перед записью",
        "Это время уже занято",
    ]

    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss

    let appointment: Appointment
    let onRejected: (Appointment) -> Void

    @State private var reason = ""
    @State private var isWorking = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(appointment.client.fullName).font(.headline)
                        Text("\(DateText.dayMonth(appointment.startsAt)), \(DateText.timeRange(appointment.startsAt, appointment.endsAt))")
                            .font(.subheadline)
                            .monospacedDigit()
                        Text("\(appointment.displayTitle) · \(appointment.master.name)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
                Section {
                    TextField("Например: мастер в отпуске", text: $reason, axis: .vertical)
                        .lineLimit(2...6)
                    ForEach(Self.quickReasons, id: \.self) { quick in
                        Button(quick) { reason = quick }
                    }
                } header: {
                    Text("Причина — по желанию")
                } footer: {
                    Text(footer)
                }
            }
            .disabled(isWorking)
            .navigationTitle("Отклонить запись")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isWorking {
                        ProgressView()
                    } else {
                        Button("Отклонить", role: .destructive, action: reject)
                    }
                }
            }
            .errorAlert($errorMessage)
        }
        .presentationDetents([.medium, .large])
    }

    private var footer: String {
        let released = "Запись отменится, время освободится."
        return appointment.client.telegramLinked
            ? "\(released) Клиент получит в Telegram причину и ссылку, чтобы записаться на другое время."
            : "\(released) Клиент получит причину и ссылку для новой записи, если у него подключён Telegram, — иначе предупредите его сами."
    }

    private func reject() {
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                let rejected = try await api.rejectOnlineBooking(id: appointment.id, reason: reason)
                onRejected(rejected)
                dismiss()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    Color.clear.sheet(isPresented: .constant(true)) {
        OnlineRejectSheet(appointment: PreviewData.appointments[1]) { _ in }
    }
    .previewEnvironment()
}
#endif
