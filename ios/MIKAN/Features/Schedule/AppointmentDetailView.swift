import SwiftUI

struct AppointmentDetailView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppState.self) private var appState
    @Environment(ScheduleStore.self) private var schedule
    @Environment(ReferenceStore.self) private var reference
    @Environment(\.openURL) private var openURL
    @Environment(\.permissions) private var permissions

    @State private var appointment: Appointment
    @State private var isWorking = false
    @State private var isStartingCheckout = false
    @State private var errorMessage: String?
    @State private var editorDraft: AppointmentDraft?
    @State private var showsComplete = false
    @State private var pendingCheckout: Appointment?
    /// The visit's receipt, shown over this card.
    @State private var showsReceipt = false
    @State private var confirmsCancel = false
    @State private var confirmsNoShow = false
    @State private var showsChat = false
    @State private var depositFlow: DepositFlow?
    /// The refund-or-retain question after a cancellation / no-show.
    @State private var depositDecision: DepositDecision?
    @State private var successCount = 0
    @State private var isConfirmingOnline = false
    @State private var rejectsOnline = false
    /// The refund-or-retain question after rejecting an online booking that holds money, asked once the sheet is gone.
    @State private var pendingDepositDecision: DepositDecision?

    init(appointment: Appointment) {
        _appointment = State(initialValue: appointment)
    }

    var body: some View {
        List {
            AppointmentHeaderSection(appointment: appointment)
            if AppointmentOnlineSection.isShown(for: appointment) {
                AppointmentOnlineSection(
                    appointment: appointment,
                    actions: OnlineBookingAction.available(for: appointment, permissions: permissions),
                    isConfirming: isConfirmingOnline,
                    onConfirm: confirmOnline,
                    onReject: { rejectsOnline = true }
                )
            }
            clientSection
            servicesSection
            detailsSection
            if DepositSummary.showsSection(appointment) {
                AppointmentDepositSection(appointment: appointment, qrEnabled: reference.qrPaymentsEnabled, showsActions: canChange) { flow in
                    depositFlow = flow
                }
            }
            if let notes = appointment.notes.nonEmpty {
                Section("Заметки") { Text(notes) }
            }
            paymentSection
            if !visibleActions.isEmpty {
                actionsSection
            } else if !actions.isEmpty {
                ReadOnlyNotice(text: "Чужие записи меняют владелец и администратор.")
            }
            AuditHistorySection(scope: .appointment(id: appointment.id))
        }
        .navigationTitle("Запись")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if appointment.isOpen, canChange {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Изменить") { editorDraft = .edit(appointment, catalog: reference.services) }
                }
            }
        }
        .disabled(isWorking)
        .refreshable { await reload() }
        .task { await reload() }
        // Catalog only adds thumbnails; the screen works without it (APIClient logs failures).
        .task { try? await reference.ensureServices() }
        // Without it the card only hides the QR-based prepayment actions.
        .task { try? await reference.ensureQrPaymentsConfig() }
        .navigationDestination(isPresented: $showsChat) {
            ClientChatView(client: appointment.client)
        }
        .sheet(item: $editorDraft) { draft in
            AppointmentEditorView(draft: draft) { saved in apply(saved) }
        }
        .sheet(isPresented: $rejectsOnline, onDismiss: askPendingDepositDecision) {
            OnlineRejectSheet(appointment: appointment) { rejected in onlineRejected(rejected) }
        }
        .appointmentDepositFlows($depositFlow, appointment: appointment, decision: depositDecision, onChange: apply)
        .sheet(isPresented: $showsComplete, onDismiss: startPendingCheckout) {
            CompleteAppointmentSheet(appointment: appointment) { completed in
                apply(completed)
            } onPay: { completed in
                pendingCheckout = completed
            }
        }
        .confirmationDialog("Отменить запись?", isPresented: $confirmsCancel, titleVisibility: .visible) {
            Button("Отменить запись", role: .destructive) { setStatus(.cancelled) }
            Button("Не отменять", role: .cancel) {}
        } message: {
            if let rule = DepositRules.closingNote(appointment, becoming: .cancelled) {
                Text("Клиенту не придёт напоминание об этой записи. \(rule)")
            } else if appointment.deposit > 0 {
                Text("Клиенту не придёт напоминание об этой записи. Предоплату \(Money.format(appointment.deposit)) затем можно вернуть или удержать.")
            } else {
                Text("Клиенту не придёт напоминание об этой записи.")
            }
        }
        .confirmationDialog("Отметить неявку?", isPresented: $confirmsNoShow, titleVisibility: .visible) {
            Button("Клиент не пришёл", role: .destructive) { setStatus(.noShow) }
            Button("Отмена", role: .cancel) {}
        } message: {
            if let rule = DepositRules.closingNote(appointment, becoming: .noShow) {
                Text(rule)
            }
        }
        .receiptFlow(isPresented: $showsReceipt) {
            // Paid, completed or still open: the card shows where the visit is now.
            Task { await reload() }
        }
        .errorAlert($errorMessage)
        .sensoryFeedback(.success, trigger: successCount)
    }

    // MARK: - Sections

    private var clientSection: some View {
        Section("Клиент") {
            NavigationLink {
                ClientDetailView(clientId: appointment.client.id)
            } label: {
                HStack(spacing: 12) {
                    InitialsAvatar(name: appointment.client.fullName, size: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(appointment.client.fullName).font(.headline)
                        if let phone = appointment.client.phone.nonEmpty {
                            Text(PhoneText.display(phone)).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    if appointment.client.telegramLinked { TelegramBadge() }
                }
            }
            if let callURL = PhoneText.callURL(appointment.client.phone) {
                Button("Позвонить", systemImage: "phone.fill") { openURL(callURL) }
            }
            if appointment.client.telegramLinked {
                Button("Открыть чат в боте", systemImage: "bubble.left.and.bubble.right.fill") { showsChat = true }
            }
        }
    }

    @ViewBuilder
    private var servicesSection: some View {
        let lines = AppointmentDraft.lines(of: appointment)
        if !lines.isEmpty {
            Section("Услуги") {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    AppointmentServiceRow(line: line, service: reference.service(id: line.serviceId))
                }
                LabeledContent("Итого") {
                    MoneyText(appointment.price)
                        .fontWeight(.semibold)
                        .foregroundStyle(.primary)
                }
            }
        }
    }

    private var detailsSection: some View {
        Section("Детали") {
            if let title = appointment.title.nonEmpty {
                LabeledContent("Описание", value: title)
            }
            LabeledContent("Мастер") {
                HStack(spacing: 6) {
                    Circle().fill(Color.master(appointment.master.color)).frame(width: 10, height: 10)
                    Text(appointment.master.name)
                }
            }
            if appointment.services.isEmpty, appointment.service == nil {
                LabeledContent("Стоимость") { MoneyText(appointment.price) }
            }
        }
    }

    @ViewBuilder
    private var paymentSection: some View {
        if let saleId = appointment.saleId {
            Section {
                NavigationLink {
                    SaleLoaderView(saleId: saleId)
                } label: {
                    Label("Оплачено", systemImage: "checkmark.seal.fill")
                        .foregroundStyle(.green)
                        .fontWeight(.semibold)
                }
            }
        } else if let checkout = VisitCheckout.of(appointment) {
            Section {
                Button {
                    startCheckout(appointment)
                } label: {
                    ZStack {
                        Label(checkout.title, systemImage: checkout.systemImage)
                            .monospacedDigit()
                            .opacity(isStartingCheckout ? 0 : 1)
                        if isStartingCheckout { ProgressView().tint(.white) }
                    }
                    .frame(maxWidth: .infinity)
                    .fontWeight(.semibold)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            } footer: {
                Text(checkout.footer)
            }
        }
    }

    /// A master sees every appointment but changes only their own; completing a visit is a till action, open to all.
    private var canChange: Bool { permissions.canChange(appointment) }

    private var visibleActions: [Action] { canChange ? actions : actions.filter { $0 == .complete } }

    private enum Action: Hashable {
        case confirm, complete, reschedule, noShow, cancel, restore
    }

    private var actions: [Action] {
        let all: [Action] = switch appointment.status {
        case .scheduled: [.confirm, .complete, .reschedule, .noShow, .cancel]
        case .confirmed: [.complete, .reschedule, .noShow, .cancel]
        case .cancelled, .noShow: [.restore]
        case .completed: []
        }
        // An unsettled online booking is confirmed or rejected in «Онлайн-запись», so the client gets the answer.
        return appointment.isUnsettledOnline ? all.filter { $0 != .confirm && $0 != .cancel } : all
    }

    private var actionsSection: some View {
        Section {
            ForEach(visibleActions, id: \.self) { action in
                switch action {
                case .confirm:
                    Button("Подтвердить", systemImage: "checkmark.circle") { setStatus(.confirmed) }
                case .complete:
                    Button("Завершить", systemImage: "flag.checkered") { showsComplete = true }
                case .reschedule:
                    Button("Перенести", systemImage: "calendar.badge.clock") {
                        editorDraft = .edit(appointment, catalog: reference.services)
                    }
                case .noShow:
                    Button("Неявка", systemImage: "person.fill.xmark") { confirmsNoShow = true }
                case .cancel:
                    Button("Отменить запись", systemImage: "xmark.circle", role: .destructive) { confirmsCancel = true }
                case .restore:
                    Button("Вернуть в запись", systemImage: "arrow.uturn.backward.circle") { setStatus(.scheduled) }
                }
            }
        } header: {
            Text("Действия")
        } footer: {
            if !canChange {
                Text("Перенести, отменить или отметить неявку в чужой записи могут владелец и администратор.")
            }
        }
    }

    // MARK: - Actions

    private func reload() async {
        do {
            apply(try await api.appointment(id: appointment.id))
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.userMessage
        }
    }

    private func apply(_ updated: Appointment) {
        appointment = updated
        schedule.upsert(updated)
    }

    private func setStatus(_ status: AppointmentStatus) {
        let before = appointment
        let changedAt = Date.now
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                let updated = try await api.setAppointmentStatus(id: appointment.id, status)
                apply(updated)
                appState.appointmentClosed(updated)
                successCount += 1
                // Cancelled / no-show with money held: refund or retain is the staff's call (the studio's rules
                // suggest how much; with automatic retain the server has already kept its share).
                if DepositFlow.needsDecision(updated) {
                    depositDecision = DepositDecision(before: before, after: updated, at: changedAt)
                    depositFlow = .decide
                }
            } catch {
                errorMessage = error.userMessage
            }
        }
    }

    // MARK: Online booking

    private func confirmOnline() {
        isWorking = true
        isConfirmingOnline = true
        Task {
            defer {
                isWorking = false
                isConfirmingOnline = false
            }
            do {
                apply(try await api.confirmOnlineBooking(id: appointment.id))
                successCount += 1
                Task { await appState.refreshBadges() }
            } catch {
                errorMessage = error.userMessage
                // Often settled elsewhere meanwhile (`409`): show the booking as it is now.
                await reload()
            }
        }
    }

    private func onlineRejected(_ rejected: Appointment) {
        let before = appointment
        apply(rejected)
        appState.appointmentClosed(rejected)
        successCount += 1
        Task { await appState.refreshBadges() }
        // Money taken before the rejection stays held: refund or retain it, as after a cancellation.
        if DepositFlow.needsDecision(rejected) {
            pendingDepositDecision = DepositDecision(before: before, after: rejected, at: .now)
        }
    }

    private func askPendingDepositDecision() {
        guard let decision = pendingDepositDecision else { return }
        pendingDepositDecision = nil
        depositDecision = decision
        depositFlow = .decide
    }

    private func startPendingCheckout() {
        guard let completed = pendingCheckout else { return }
        pendingCheckout = nil
        startCheckout(completed)
    }

    /// Opens the visit's receipt over this card (creating it with the services, client and prepayment if needed):
    /// jewelry is added and the visit paid right here, without switching to «Касса».
    private func startCheckout(_ target: Appointment) {
        isWorking = true
        isStartingCheckout = true
        Task {
            defer {
                isWorking = false
                isStartingCheckout = false
            }
            do {
                try await appState.startCheckout(for: target)
                showsReceipt = true
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

private struct AppointmentHeaderSection: View {
    let appointment: Appointment

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    AppointmentStatusBadge(status: appointment.status)
                    Spacer()
                    Text(DateText.duration(minutes: appointment.durationMin))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Text(DateText.timeRange(appointment.startsAt, appointment.endsAt))
                    .font(.system(.largeTitle, design: .rounded).weight(.bold))
                    .monospacedDigit()
                Text(DateText.weekdayDayMonth(appointment.startsAt))
                    .font(.headline)
                    .foregroundStyle(.secondary)
                Text(appointment.displayTitle)
                    .font(.title3.weight(.semibold))
                    .lineLimit(3)
                    .padding(.top, 4)
            }
            .padding(.vertical, 6)
            .accessibilityElement(children: .combine)
        }
    }
}

/// Booked service line: catalog cover (or category icon), name, duration and price.
private struct AppointmentServiceRow: View {
    let line: DraftServiceLine
    let service: Service?

    var body: some View {
        HStack(spacing: 12) {
            if let service {
                ServiceThumbnail(service: service, size: 40)
            } else {
                ProductThumbnail(path: nil, size: 40, placeholderSymbol: line.category?.symbol ?? "sparkles")
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(line.name)
                if let minutes = line.durationMin, minutes > 0 {
                    Text(DateText.duration(minutes: minutes))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            MoneyText(line.price)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        AppointmentDetailView(appointment: PreviewData.appointments[0])
    }
    .previewEnvironment()
}

#Preview("Несколько услуг") {
    NavigationStack {
        AppointmentDetailView(appointment: PreviewData.appointments[2])
    }
    .previewEnvironment()
}
#endif
