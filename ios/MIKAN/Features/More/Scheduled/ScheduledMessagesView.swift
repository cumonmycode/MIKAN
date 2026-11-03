import SwiftUI

/// Aftercare, reminder and post-visit messages queued by the bot.
struct ScheduledMessagesView: View {
    @Environment(APIClient.self) private var api
    @State private var status: ScheduledStatus = .pending
    /// The filter on screen: cleared only for another one, not when the screen reappears after a swipe back.
    @State private var shownStatus: ScheduledStatus?
    @State private var messages = Remote<[ScheduledMessage]>()
    @State private var pendingCancel: ScheduledMessage?
    @State private var errorMessage: String?

    private static let filters: [ScheduledStatus] = [.pending, .sent, .failed]

    private var groups: [(day: Date, items: [ScheduledMessage])] {
        let calendar = Calendar.app
        let grouped = Dictionary(grouping: messages.value ?? []) { calendar.startOfDay(for: $0.sendAt) }
        let ascending = status == .pending
        let days = grouped.keys.sorted { ascending ? $0 < $1 : $0 > $1 }
        return days.map { day in (day, grouped[day] ?? []) }
    }

    var body: some View {
        List {
            ForEach(groups, id: \.day) { group in
                Section(DateText.dayTitle(group.day)) {
                    ForEach(group.items) { message in
                        ScheduledMessageRow(message: message)
                            .swipeActions(edge: .trailing) {
                                if message.status == .pending {
                                    Button("Отменить", systemImage: "xmark") { pendingCancel = message }
                                        .tint(.red)
                                }
                            }
                    }
                }
            }
        }
        .safeAreaBar(edge: .top) {
            Picker("Статус", selection: $status) {
                ForEach(Self.filters, id: \.self) { status in
                    Text(status.filterTitle).tag(status)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .overlay {
            RemoteStateOverlay(remote: messages, retry: load) {
                ContentUnavailableView(
                    status.emptyTitle,
                    systemImage: "clock.badge.checkmark",
                    description: Text(status == .pending
                        ? "Памятки по уходу, напоминания о записи и сообщения после визита появятся здесь, когда бот их запланирует."
                        : "Пока ничего нет.")
                )
            }
        }
        .refreshable { await load() }
        .task(id: status) {
            if shownStatus != status { messages.reset() }
            shownStatus = status
            await load()
        }
        .remoteErrorAlert(messages)
        .errorAlert($errorMessage)
        .confirmationDialog("Отменить отправку?", isPresented: cancelBinding, titleVisibility: .visible, presenting: pendingCancel) { message in
            Button("Не отправлять", role: .destructive) { cancel(message) }
            Button("Оставить", role: .cancel) {}
        } message: { message in
            Text("Сообщение для \(message.client?.fullName ?? "клиента") не будет отправлено.")
        }
        .navigationTitle("Запланированные")
    }

    private var cancelBinding: Binding<Bool> {
        Binding(get: { pendingCancel != nil }, set: { if !$0 { pendingCancel = nil } })
    }

    private func load() async {
        let status = status
        await messages.load { try await api.scheduledMessages(status: status) }
    }

    private func cancel(_ message: ScheduledMessage) {
        Task {
            do {
                _ = try await api.cancelScheduledMessage(id: message.id)
                withAnimation { messages.remove(id: message.id) }
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

private extension ScheduledStatus {
    var filterTitle: String {
        switch self {
        case .pending: "Ожидают"
        case .sent: "Отправлены"
        case .failed: "Ошибки"
        case .cancelled: "Отменены"
        }
    }

    var emptyTitle: String {
        switch self {
        case .pending: "Нет запланированных"
        case .sent: "Ничего не отправлено"
        case .failed: "Ошибок нет"
        case .cancelled: "Нет отменённых"
        }
    }
}

private extension ScheduledKind {
    var color: Color {
        switch self {
        case .aftercare: .teal
        case .reminder: .blue
        case .healingCheck: .pink
        case .jewelryChange: .purple
        case .rescheduleNotice: .orange
        case .other: .gray
        }
    }
}

private struct ScheduledMessageRow: View {
    let message: ScheduledMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(message.client?.fullName ?? "Клиент").font(.headline)
                StatusBadge(text: message.kind.title, color: message.kind.color)
                Spacer()
                Text(DateText.time(message.sentAt ?? message.sendAt))
                    .font(.subheadline)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            Text(ChatMarkdown.render(message.text))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(3)
            if let error = message.error.nonEmpty {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        ScheduledMessagesView()
    }
    .previewEnvironment()
}
#endif
