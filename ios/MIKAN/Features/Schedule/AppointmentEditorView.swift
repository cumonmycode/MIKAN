import SwiftUI

/// Create / reschedule an appointment. Handles `409 schedule_conflict` (a busy master or time outside their own
/// schedule) by asking «Записать всё равно?» and retrying with `force`.
/// A new appointment that needs a prepayment continues to the prepayment screen instead of closing.
struct AppointmentEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    @Environment(AppState.self) private var appState
    @Environment(ReferenceStore.self) private var reference
    @Environment(\.permissions) private var permissions

    @State private var draft: AppointmentDraft
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var conflictMessage: String?
    @State private var referenceError: String?
    /// The created appointment whose prepayment is collected next.
    @State private var depositAppointment: Appointment?
    /// Telegram chat of the booking request the appointment comes from: the prepayment link goes there.
    let bookingChatId: Int64?
    /// Called once saved, and again whenever the prepayment screen changes the appointment.
    let onSaved: (Appointment) -> Void

    init(draft: AppointmentDraft, bookingChatId: Int64? = nil, onSaved: @escaping (Appointment) -> Void) {
        _draft = State(initialValue: draft)
        self.bookingChatId = bookingChatId
        self.onSaved = onSaved
    }

    var body: some View {
        NavigationStack {
            Form {
                clientSection
                masterSection
                AppointmentServicesSection(draft: $draft)
                timeSection
                paymentSection
                depositSection
                Section("Заметки") {
                    TextField("Пожелания, эскиз, зона…", text: $draft.notes, axis: .vertical)
                        .lineLimit(3...8)
                }
            }
            .navigationTitle(draft.isEditing ? "Изменить запись" : "Новая запись")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Сохранить") { save(force: false) }
                            .disabled(!draft.isValid)
                    }
                }
            }
            .interactiveDismissDisabled(isSaving)
            .navigationDestination(item: $depositAppointment) { saved in
                DepositCollectView(appointment: saved, bookingChatId: bookingChatId, onChange: onSaved) { dismiss() }
                    .navigationBarBackButtonHidden()
            }
            .task { await loadReference() }
            // Another master (or the first one chosen) charges their own prices for the lines nobody edited.
            .onChange(of: draft.masterId) { draft.repriceLines(from: reference.services) }
            .errorAlert($errorMessage)
            .alert("Записать всё равно?", isPresented: conflictBinding) {
                Button("Записать") { save(force: true) }
                Button("Изменить время", role: .cancel) {}
            } message: {
                Text(conflictMessage ?? "")
            }
        }
    }

    private var clientSection: some View {
        Section("Клиент") {
            NavigationLink {
                ClientPickerView(selection: $draft.client, suggestion: draft.clientSuggestion)
            } label: {
                if let client = draft.client {
                    HStack(spacing: 12) {
                        InitialsAvatar(name: client.fullName, size: 34)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(client.fullName).foregroundStyle(.primary)
                            if let phone = client.phone.nonEmpty {
                                Text(PhoneText.display(phone)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } else {
                    Label("Выберите клиента", systemImage: "person.crop.circle.badge.plus")
                }
            }
        }
    }

    private var masterSection: some View {
        Section {
            if !permissions.picksMaster {
                // A master books and moves only their own appointments.
                LabeledContent("Мастер", value: appState.employee?.name ?? "—")
            } else if reference.masters.isEmpty, referenceError == nil {
                LabeledContent("Мастер") { ProgressView() }
            } else {
                Picker("Мастер", selection: $draft.masterId) {
                    Text("Не выбран").tag(Int?.none)
                    ForEach(reference.masters) { master in
                        Text(master.name).tag(Int?.some(master.id))
                    }
                }
            }
        } footer: {
            if let referenceError {
                Text(referenceError).foregroundStyle(.red)
            }
        }
    }

    /// Any time can be picked: the studio may open early or stay late. Outside working hours is only noted.
    private var timeSection: some View {
        Section {
            DatePicker("Дата", selection: $draft.start, displayedComponents: .date)
            DatePicker("Начало", selection: $draft.start, displayedComponents: .hourAndMinute)
            Stepper(value: $draft.durationMin, in: AppointmentDraft.durationStep...(12 * 60), step: AppointmentDraft.durationStep) {
                LabeledContent("Длительность", value: DateText.duration(minutes: draft.durationMin))
            }
            DatePicker("Окончание", selection: endBinding, in: draft.start.addingTimeInterval(5 * 60)..., displayedComponents: .hourAndMinute)
        } header: {
            Text("Время")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                MasterDayHint(masterId: draft.masterId, start: draft.start, end: draft.end)
                if !reference.workday.contains(start: draft.start, end: draft.end, calendar: .app) {
                    Label("Вне рабочего времени студии (\(reference.workday.title)). Запись сохранится — календарь покажет её.", systemImage: "clock.badge.exclamationmark")
                }
            }
        }
    }

    private var paymentSection: some View {
        Section {
            if draft.lines.isEmpty {
                NumberField.money("Стоимость", value: $draft.price)
            } else {
                LabeledContent("Стоимость") {
                    MoneyText(draft.total).foregroundStyle(.primary)
                }
                if draft.priceOverride != nil {
                    Button("Пересчитать по услугам", systemImage: "arrow.triangle.2.circlepath") {
                        draft.recalculateTotal()
                    }
                }
            }
        } header: {
            Text("Оплата")
        } footer: {
            if draft.priceOverride != nil {
                Text("Отличается от суммы услуг (\(Money.format(draft.linesTotal))). Изменение услуг или их цен пересчитает стоимость.")
            } else if !draft.lines.isEmpty {
                Text("Сумма услуг — цену каждой можно изменить выше.")
            }
        }
    }

    private var depositSection: some View {
        Section {
            NumberField.money("Предоплата", value: $draft.depositRequired)
            if draft.depositOverride != nil, !draft.lines.isEmpty {
                Button("Пересчитать по услугам", systemImage: "arrow.triangle.2.circlepath") {
                    draft.recalculateDeposit()
                }
            }
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if draft.linesDeposit > 0 || (draft.depositOverride != nil && !draft.lines.isEmpty) {
                    Text(draft.depositOverride == nil
                        ? "По услугам: \(Money.format(draft.linesDeposit))"
                        : "Отличается от предоплаты по услугам (\(Money.format(draft.linesDeposit))).")
                }
                if draft.isEditing, draft.heldDeposit > 0 || draft.depositRequired > 0 {
                    Text("Внесено: \(Money.format(draft.heldDeposit))")
                }
                if draft.depositRequired > draft.total {
                    Text("Предоплата больше стоимости.").foregroundStyle(.orange)
                }
            }
            .monospacedDigit()
        }
    }

    private var endBinding: Binding<Date> {
        Binding(
            get: { draft.end },
            set: { newEnd in
                let minutes = Int(newEnd.timeIntervalSince(draft.start) / 60)
                draft.durationMin = max(5, minutes)
            }
        )
    }

    private var conflictBinding: Binding<Bool> {
        Binding(get: { conflictMessage != nil }, set: { if !$0 { conflictMessage = nil } })
    }

    private func loadReference() async {
        // A master books only themselves, whatever column or request the draft came from.
        draft.masterId = permissions.master(for: draft.masterId)
        do {
            try await reference.ensureEmployees()
            try await reference.ensureServices()
            try? await reference.ensureWorkday()
            draft.resolveCatalog(from: reference.services)
            referenceError = nil
            if draft.masterId == nil, let me = appState.employee, me.isMaster, me.active {
                draft.masterId = me.id
            } else if draft.masterId == nil, reference.masters.count == 1 {
                draft.masterId = reference.masters.first?.id
            }
        } catch {
            referenceError = error.userMessage
        }
    }

    private func save(force: Bool) {
        guard let body = draft.body(force: force) else { return }
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let saved: Appointment
                if let id = draft.appointmentId {
                    saved = try await api.updateAppointment(id: id, body)
                } else {
                    saved = try await api.createAppointment(body)
                }
                onSaved(saved)
                if !draft.isEditing, DepositSummary.asksForDeposit(afterCreating: saved) {
                    depositAppointment = saved
                } else {
                    dismiss()
                }
            } catch let error as APIError where error.isScheduleConflict {
                conflictMessage = error.message
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    AppointmentEditorView(draft: .new(day: .now, client: PreviewData.ivanRef)) { _ in }
        .previewEnvironment()
}

#Preview("Несколько услуг") {
    AppointmentEditorView(draft: .edit(PreviewData.appointments[2])) { _ in }
        .previewEnvironment()
}
#endif
