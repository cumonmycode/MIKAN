import SwiftUI

/// «Онлайн-запись» in the appointment card: where the client booked and, while the booking is unsettled, its state
/// with «Подтвердить запись» / «Отклонить» for the roles that may act on it.
struct AppointmentOnlineSection: View {
    let appointment: Appointment
    let actions: [OnlineBookingAction]
    let isConfirming: Bool
    let onConfirm: () -> Void
    let onReject: () -> Void

    /// Booked by the client, or still waiting to be settled.
    static func isShown(for appointment: Appointment) -> Bool {
        appointment.channel.isOnline || appointment.isUnsettledOnline
    }

    private var mark: OnlineMark? { OnlineMark.of(appointment) }

    var body: some View {
        Section {
            if let booked = appointment.channel.bookedText {
                Label(booked, systemImage: appointment.channel.symbol)
            }
            if let mark {
                Label(mark.text, systemImage: mark.symbol)
                    .foregroundStyle(mark.color)
                    .fontWeight(.semibold)
                    .monospacedDigit()
            }
            if actions.contains(.confirm) {
                Button(action: onConfirm) {
                    HStack {
                        Label("Подтвердить запись", systemImage: "checkmark.circle.fill")
                            .fontWeight(.semibold)
                        Spacer(minLength: 8)
                        if isConfirming { ProgressView() }
                    }
                }
            }
            if actions.contains(.reject) {
                Button("Отклонить", systemImage: "xmark.circle", role: .destructive, action: onReject)
            }
        } header: {
            Text("Онлайн-запись")
        } footer: {
            if let footer {
                Text(footer)
            }
        }
    }

    private var footer: String? {
        switch mark {
        case nil:
            return nil
        case _ where actions.isEmpty:
            return "Подтвердить или отклонить её могут мастер этой записи, владелец и администратор."
        case .awaitingConfirmation:
            return "Время уже за клиентом. После подтверждения ему придёт сообщение с деталями записи, после отказа — причина и ссылка, чтобы выбрать другое время."
        case .awaitingPayment(let until):
            let deadline = until.map { "до \(DateText.time($0))" } ?? "вовремя"
            return "Клиент оплачивает предоплату по QR. Если не оплатит \(deadline), запись отменится сама и время освободится."
        }
    }
}

#if DEBUG
#Preview {
    var booking = PreviewData.appointments[1]
    booking.channel = .web
    booking.onlineState = .awaitingPayment
    booking.holdUntil = .now.addingTimeInterval(900)
    return List {
        AppointmentOnlineSection(appointment: booking, actions: [.reject], isConfirming: false, onConfirm: {}, onReject: {})
    }
}
#endif
