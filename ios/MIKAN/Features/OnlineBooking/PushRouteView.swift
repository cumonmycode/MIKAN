import SwiftUI

/// The screen of a tapped push notification, shown in a sheet over whatever tab is open.
struct PushRouteView: View {
    @Environment(\.dismiss) private var dismiss
    let route: PushRoute

    var body: some View {
        NavigationStack {
            destination
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Закрыть") { dismiss() }
                    }
                }
        }
    }

    @ViewBuilder
    private var destination: some View {
        switch route {
        case .appointment(let id):
            AppointmentLoaderView(appointmentId: id)
        case .chat(let chatId):
            ChatResolverView(title: "Чат с клиентом", lookup: .telegramChat(id: chatId))
        case .bookingRequests:
            BookingRequestsView()
        case .onlineBookings:
            OnlineBookingsView()
        }
    }
}

/// Loads an appointment by id (a notification knows only the id) and shows its card.
struct AppointmentLoaderView: View {
    @Environment(APIClient.self) private var api
    let appointmentId: Int
    @State private var appointment = Remote<Appointment>()

    var body: some View {
        Group {
            if let value = appointment.value {
                AppointmentDetailView(appointment: value)
            } else {
                RemoteStateOverlay(remote: appointment, retry: load)
                    .navigationTitle("Запись")
                    .navigationBarTitleDisplayMode(.inline)
            }
        }
        .task { await load() }
    }

    private func load() async {
        await appointment.load { try await api.appointment(id: appointmentId) }
    }
}

#if DEBUG
#Preview {
    PushRouteView(route: .onlineBookings)
        .previewEnvironment()
}
#endif
