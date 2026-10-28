import SwiftUI

/// «Перенести запись Анны на 21 октября, 15:00?» after a drop in the calendar, with «Уведомить клиента в Telegram».
/// Another master re-prices the service lines nobody edited. A schedule conflict asks «Записать всё равно?». Closing
/// without saving puts the appointment back.
struct AppointmentMoveSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    @Environment(ReferenceStore.self) private var reference

    let move: AppointmentMove
    let onSaved: (Appointment) -> Void
    /// The move may or may not have reached the server: the calendar reloads.
    let onFailed: () -> Void

    @State private var notifyClient = true
    @State private var isSaving = false
    @State private var conflictMessage: String?
    @State private var errorMessage: String?

    private var appointment: Appointment { move.appointment }

    private var newMasterName: String {
        reference.employees.first { $0.id == move.target.masterId }?.name ?? "другой мастер"
    }

    /// The new master's prices, once the catalog is loaded.
    private var repricing: AppointmentMoveRepricing? { move.repricing(catalog: reference.services) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(AppointmentMoveText.question(move))
                            .font(.headline)
                        Text("\(appointment.client.fullName) · \(appointment.displayTitle)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                    LabeledContent("Было", value: AppointmentMoveText.slot(appointment.startsAt, appointment.endsAt))
                    LabeledContent("Станет", value: AppointmentMoveText.slot(move.target.startsAt, move.target.endsAt))
                    if move.changesMaster {
                        LabeledContent("Мастер", value: "\(appointment.master.name) → \(newMasterName)")
                    }
                    if let repricing {
                        LabeledContent("Стоимость") {
                            Text("\(Money.format(appointment.price)) → \(Money.format(repricing.price))")
                                .monospacedDigit()
                        }
                    }
                } footer: {
                    if repricing != nil {
                        Text("Цены услуг — как у мастера \(newMasterName). Цены, изменённые вручную, остаются.")
                    }
                }
                if move.offersTelegramNotice() {
                    Section {
                        Toggle("Уведомить клиента в Telegram", isOn: $notifyClient)
                    } footer: {
                        Text("Бот пришлёт новое время с кнопками «Приду» и «Перенести».")
                    }
                }
            }
            .disabled(isSaving)
            .navigationTitle("Перенос записи")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Перенести") { save(force: false) }
                    }
                }
            }
            .interactiveDismissDisabled(isSaving)
            // Only re-prices the lines; without the catalog the move keeps the prices.
            .task { try? await reference.ensureServices() }
            .alert("Записать всё равно?", isPresented: present($conflictMessage)) {
                Button("Записать") { save(force: true) }
                Button("Отмена", role: .cancel) { dismiss() }
            } message: {
                Text(conflictMessage ?? "")
            }
            .alert("Не удалось перенести", isPresented: present($errorMessage)) {
                Button("OK", role: .cancel) { dismiss() }
            } message: {
                Text(errorMessage ?? "")
            }
        }
        .presentationDetents([.medium])
    }

    private func present(_ message: Binding<String?>) -> Binding<Bool> {
        Binding(get: { message.wrappedValue != nil }, set: { if !$0 { message.wrappedValue = nil } })
    }

    private func save(force: Bool) {
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let body = move.body(notifyClient: notifyClient, force: force, repricing: repricing)
                let saved = try await api.moveAppointment(id: appointment.id, body)
                onSaved(saved)
                dismiss()
            } catch let error as APIError where error.isScheduleConflict {
                conflictMessage = error.message
            } catch {
                onFailed()
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    let appointment = PreviewData.appointments[0]
    let start = appointment.startsAt.addingTimeInterval(26 * 3600)
    let target = DragTarget(
        column: 1,
        startMinute: TimeGridLayout.minuteOfDay(start, calendar: .app),
        startsAt: start,
        endsAt: start.addingTimeInterval(appointment.endsAt.timeIntervalSince(appointment.startsAt)),
        masterId: appointment.master.id
    )
    Text("Календарь")
        .sheet(isPresented: .constant(true)) {
            AppointmentMoveSheet(move: AppointmentMove(appointment: appointment, target: target), onSaved: { _ in }, onFailed: {})
        }
        .previewEnvironment()
}
#endif
