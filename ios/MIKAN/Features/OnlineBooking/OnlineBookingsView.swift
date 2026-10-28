import SwiftUI

/// «Онлайн-записи»: bookings clients made themselves (site, Mini App, bot) that wait for staff confirmation or for
/// the prepayment. Owner and admin confirm or reject any of them, a master their own.
struct OnlineBookingsView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppState.self) private var appState
    @Environment(ScheduleStore.self) private var schedule
    @Environment(\.permissions) private var permissions

    @State private var bookings = Remote<[Appointment]>()
    @State private var rejecting: Appointment?
    @State private var confirmingId: Int?
    @State private var errorMessage: String?
    @State private var successCount = 0
    /// A rejected booking that still holds a prepayment, told about once the reject sheet is gone.
    @State private var pendingHeldDeposit: Appointment?
    @State private var heldDeposit: Appointment?
    /// The card opened to refund or retain that prepayment.
    @State private var openedAppointment: Appointment?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(OnlineBookingQueue.states, id: \.self) { state in
                    let items = OnlineBookingQueue.items(bookings.value ?? [], in: state)
                    if !items.isEmpty {
                        OnlineBookingSectionHeader(state: state, count: items.count)
                        ForEach(items) { appointment in
                            OnlineBookingCard(
                                appointment: appointment,
                                actions: OnlineBookingAction.available(for: appointment, permissions: permissions),
                                isConfirming: confirmingId == appointment.id,
                                onConfirm: { confirm(appointment) },
                                onReject: { rejecting = appointment }
                            )
                        }
                    }
                }
            }
            .padding(16)
            .disabled(confirmingId != nil)
        }
        .background { AuraBackground() }
        .overlay {
            RemoteStateOverlay(remote: bookings, retry: load) {
                ContentUnavailableView {
                    Label("Онлайн-записей нет", systemImage: "globe")
                } description: {
                    Text("Здесь появятся записи, которые клиенты сделали сами — на сайте, в Mini App или через бота, — пока они ждут подтверждения или оплаты.")
                } actions: {
                    NavigationLink("Ссылка для записи") { BookingLinkView() }
                        .buttonStyle(.glass)
                }
            }
        }
        .refreshable { await load() }
        // Also when the badge poll sees a new booking or one settled elsewhere.
        .task(id: appState.badges.onlineAwaiting) { await load() }
        .remoteErrorAlert(bookings)
        .errorAlert($errorMessage)
        .sheet(item: $rejecting, onDismiss: showHeldDeposit) { appointment in
            OnlineRejectSheet(appointment: appointment) { rejected in
                apply(rejected)
                appState.appointmentClosed(rejected)
                successCount += 1
                // Money taken before the rejection stays held: refund or retain it in the card.
                if DepositFlow.needsDecision(rejected) { pendingHeldDeposit = rejected }
            }
        }
        .alert("Предоплата осталась у студии", isPresented: showsHeldDeposit, presenting: heldDeposit) { appointment in
            Button("Открыть запись") { openedAppointment = appointment }
            Button("Позже", role: .cancel) {}
        } message: { appointment in
            Text("Клиент внёс \(Money.format(appointment.deposit)). Верните предоплату или удержите её в карточке записи.")
        }
        .navigationDestination(item: $openedAppointment) { appointment in
            AppointmentDetailView(appointment: appointment)
        }
        .sensoryFeedback(.success, trigger: successCount)
        .navigationTitle("Онлайн-записи")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func load() async {
        await bookings.load {
            async let confirmation = api.onlineBookings(state: .awaitingConfirmation)
            async let payment = api.onlineBookings(state: .awaitingPayment)
            return OnlineBookingQueue.ordered(try await confirmation + payment)
        }
    }

    private func confirm(_ appointment: Appointment) {
        confirmingId = appointment.id
        Task {
            defer { confirmingId = nil }
            do {
                apply(try await api.confirmOnlineBooking(id: appointment.id))
                successCount += 1
            } catch {
                errorMessage = error.userMessage
                // Often settled elsewhere meanwhile (`409`): show the list as it is now.
                await load()
            }
        }
    }

    private var showsHeldDeposit: Binding<Bool> {
        Binding(get: { heldDeposit != nil }, set: { if !$0 { heldDeposit = nil } })
    }

    private func showHeldDeposit() {
        heldDeposit = pendingHeldDeposit
        pendingHeldDeposit = nil
    }

    private func apply(_ updated: Appointment) {
        bookings.update { OnlineBookingQueue.applying(updated, to: $0) }
        schedule.upsert(updated)
        Task { await appState.refreshBadges() }
    }
}

/// «Ждут подтверждения · 2» with a hint of what happens next.
private struct OnlineBookingSectionHeader: View {
    let state: OnlineBookingState
    let count: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(OnlineBookingQueue.title(state)) · \(count)")
                .font(.title3.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            Text(hint)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 4)
    }

    private var hint: String {
        switch state {
        case .awaitingConfirmation:
            "Время уже за клиентом. Подтвердите запись или отклоните её — клиент получит ответ."
        case .awaitingPayment:
            "Клиент оплачивает предоплату по QR. Если не оплатит вовремя, запись отменится сама и время освободится."
        }
    }
}

/// A booking: the appointment card (opens it), the channel and the actions the role allows.
private struct OnlineBookingCard: View {
    let appointment: Appointment
    let actions: [OnlineBookingAction]
    let isConfirming: Bool
    let onConfirm: () -> Void
    let onReject: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            NavigationLink {
                AppointmentDetailView(appointment: appointment)
            } label: {
                VStack(alignment: .leading, spacing: 6) {
                    AppointmentCard(appointment: appointment, showsDate: true)
                    if let booked = appointment.channel.bookedText {
                        Label(booked, systemImage: appointment.channel.symbol)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if actions.isEmpty {
                Text("Подтвердить или отклонить её могут мастер этой записи, владелец и администратор.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 10) {
                    Spacer(minLength: 0)
                    if actions.contains(.reject) {
                        Button("Отклонить", role: .destructive, action: onReject)
                            .buttonStyle(.glass)
                    }
                    if actions.contains(.confirm) {
                        Button(action: onConfirm) {
                            ZStack {
                                Text("Подтвердить").opacity(isConfirming ? 0 : 1)
                                if isConfirming { ProgressView() }
                            }
                            .fontWeight(.semibold)
                        }
                        .buttonStyle(.glassProminent)
                    }
                }
            }
        }
        .cardStyle(padding: 12)
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        OnlineBookingsView()
    }
    .previewEnvironment()
}
#endif
