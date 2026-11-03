import SwiftUI

extension BookingStatus {
    var title: String {
        switch self {
        case .new: "Новые"
        case .processed: "Обработанные"
        case .rejected: "Отклонённые"
        }
    }

    var singularTitle: String {
        switch self {
        case .new: "Новая"
        case .processed: "Обработана"
        case .rejected: "Отклонена"
        }
    }

    var color: Color {
        switch self {
        case .new: .orange
        case .processed: .green
        case .rejected: .gray
        }
    }
}

/// Booking requests created by the bot.
struct BookingRequestsView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppState.self) private var appState
    @State private var status: BookingStatus = .new
    /// The filter on screen: cleared only for another one, not when the screen reappears after a swipe back.
    @State private var shownStatus: BookingStatus?
    @State private var requests = Remote<[BookingRequest]>()

    var body: some View {
        List {
            ForEach(requests.value ?? []) { request in
                NavigationLink {
                    BookingRequestDetailView(request: request) { updated in
                        if updated.status != status {
                            requests.remove(id: updated.id)
                        } else {
                            requests.upsert(updated)
                        }
                        Task { await appState.refreshBadges() }
                    }
                } label: {
                    BookingRequestRow(request: request)
                }
            }
        }
        .safeAreaBar(edge: .top) {
            Picker("Статус", selection: $status) {
                ForEach(BookingStatus.allCases) { status in
                    Text(status.title).tag(status)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .overlay {
            RemoteStateOverlay(remote: requests, retry: load) {
                ContentUnavailableView(
                    status == .new ? "Новых заявок нет" : "Пусто",
                    systemImage: "tray",
                    description: Text(status == .new
                        ? "Бот создаёт заявку, когда клиент просит записать его. Они появятся здесь."
                        : "Здесь будут заявки со статусом «\(status.singularTitle.lowercased())».")
                )
            }
        }
        .refreshable { await load() }
        .task(id: status) {
            if shownStatus != status { requests.reset() }
            shownStatus = status
            await load()
        }
        .remoteErrorAlert(requests)
        .navigationTitle("Заявки")
    }

    private func load() async {
        let status = status
        await requests.load { try await api.bookingRequests(status: status) }
    }
}

private struct BookingRequestRow: View {
    let request: BookingRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(request.displayName).font(.headline)
                Spacer()
                Text(DateText.relative(request.createdAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let service = request.serviceName.nonEmpty {
                Text(service).font(.subheadline)
            }
            if let time = request.preferredTime.nonEmpty {
                Label(time, systemImage: "clock")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        BookingRequestsView()
    }
    .previewEnvironment()
}
#endif
