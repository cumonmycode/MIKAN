import SwiftUI

struct ChatsListView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppState.self) private var appState
    @State private var chats = Remote<[BotChat]>()
    @State private var search = ""
    @State private var filter: ChatFilter = .all

    private static let pollInterval: Duration = .seconds(15)

    private var filtered: [BotChat] { filter.apply(to: chats.value ?? [], search: search) }

    /// The filter appears once a staff chat exists (and stays while it is not «Все»).
    private var showsFilter: Bool {
        filter != .all || (chats.value ?? []).contains(where: \.isStaff)
    }

    var body: some View {
        List {
            ForEach(filtered) { chat in
                NavigationLink {
                    ChatView(chat: chat) { updated in chats.upsert(updated) }
                } label: {
                    ChatRow(chat: chat)
                }
            }
        }
        .listStyle(.plain)
        // A collapsing large title or an auto-hiding search drawer above the pinned filter
        // made the list shake while scrolling, so both stay put.
        .searchable(
            text: $search,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Имя или @username"
        )
        .safeAreaBar(edge: .top) {
            if showsFilter {
                Picker("Чаты", selection: $filter.animation()) {
                    ForEach(ChatFilter.allCases) { filter in
                        Text(filter.title).tag(filter)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
        }
        .overlay {
            RemoteStateOverlay(remote: chats, isEmpty: { _ in filtered.isEmpty }, retry: load) {
                emptyState
            }
        }
        .refreshable { await load() }
        .task {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: Self.pollInterval)
            }
        }
        .remoteErrorAlert(chats)
        .navigationTitle("Чаты")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private var emptyState: some View {
        if !search.trimmed.isEmpty {
            ContentUnavailableView.search(text: search)
        } else if filter == .staff {
            ContentUnavailableView(
                "Чатов сотрудников нет",
                systemImage: "person.badge.shield.checkmark",
                description: Text(StaffBotHelp.howToLink)
            )
        } else {
            ContentUnavailableView(
                "Чатов пока нет",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("Когда клиенты напишут боту в Telegram, переписка появится здесь.")
            )
        }
    }

    private func load() async {
        await chats.load { try await api.chats() }
        await appState.refreshBadges()
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        ChatsListView()
    }
    .previewEnvironment()
}
#endif
