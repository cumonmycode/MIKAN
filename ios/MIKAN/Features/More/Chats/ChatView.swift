import SwiftUI

/// Conversation with a client. Marks read on open, refreshes every 5 s while visible.
struct ChatView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppState.self) private var appState
    @Environment(\.permissions) private var permissions

    @State private var chat: BotChat
    var onChange: ((BotChat) -> Void)?

    @State private var messages: [BotMessage] = []
    @State private var hasLoaded = false
    @State private var loadError: String?
    @State private var hasEarlier = false
    @State private var isLoadingEarlier = false
    @State private var draft = ""
    @State private var isSending = false
    @State private var isTogglingAI = false
    @State private var errorMessage: String?
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var sentCount = 0
    @State private var unlinkedCount = 0
    @State private var boundCount = 0

    private static let pageSize = 50
    private static let pollInterval: Duration = .seconds(5)

    init(chat: BotChat, onChange: ((BotChat) -> Void)? = nil) {
        _chat = State(initialValue: chat)
        self.onChange = onChange
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 8) {
                if hasEarlier {
                    Button {
                        Task { await loadEarlier() }
                    } label: {
                        if isLoadingEarlier { ProgressView() } else { Text("Показать ранние сообщения") }
                    }
                    .buttonStyle(.glass)
                    .controlSize(.small)
                    .padding(.vertical, 8)
                }
                ForEach(rows) { row in
                    switch row {
                    case .day(let date):
                        Text(DateText.dayTitle(date))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 6)
                    case .message(let message):
                        ChatBubble(message: message)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
        .defaultScrollAnchor(.bottom)
        .scrollPosition($position)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaBar(edge: .top) {
            if let employee = chat.employee {
                StaffChatBanner(chatId: chat.chatId, employee: employee, onUnlinked: employeeUnlinked)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .safeAreaBar(edge: .bottom) {
            ChatComposer(text: $draft, placeholder: "Ответ от студии", isSending: isSending, onSend: send)
        }
        .overlay { stateOverlay }
        .navigationTitle(chat.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .task { await pollLoop() }
        .errorAlert($errorMessage)
        .sensoryFeedback(.success, trigger: sentCount)
        .sensoryFeedback(.success, trigger: unlinkedCount)
        .sensoryFeedback(.success, trigger: boundCount)
    }

    @ViewBuilder
    private var stateOverlay: some View {
        if !hasLoaded {
            if let loadError {
                ErrorStateView(message: loadError) { await refresh() }
            } else {
                ProgressView()
            }
        } else if messages.isEmpty {
            ContentUnavailableView(
                "Сообщений нет",
                systemImage: "bubble.left",
                description: Text(chat.isStaff ? "Напишите сотруднику первым." : "Напишите клиенту первым.")
            )
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if let client = chat.client {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    ClientDetailView(clientId: client.id)
                } label: {
                    Label("Карточка клиента", systemImage: "person.crop.circle")
                }
            }
            ToolbarSpacer(.fixed, placement: .topBarTrailing)
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button(action: toggleAI) {
                Label(chat.aiPaused ? "ИИ на паузе" : "ИИ отвечает", systemImage: chat.aiPaused ? "pause.circle" : "sparkles")
                    .labelStyle(.titleAndIcon)
            }
            .disabled(isTogglingAI)
            .accessibilityHint(chat.aiPaused ? "Включить ответы ИИ" : "Поставить ИИ на паузу")
        }
        if StaffBinding.canBind(chat), permissions.editsSettings {
            ToolbarSpacer(.fixed, placement: .topBarTrailing)
            ToolbarItem(placement: .topBarTrailing) {
                StaffBindingMenu(chat: chat, onBound: employeeBound)
            }
        }
    }

    // MARK: - Rows

    private enum Row: Identifiable {
        case day(Date)
        case message(BotMessage)

        var id: String {
            switch self {
            case .day(let date): "day-\(date.timeIntervalSince1970)"
            case .message(let message): "m-\(message.id)"
            }
        }
    }

    private var rows: [Row] {
        let calendar = Calendar.app
        var result: [Row] = []
        var currentDay: Date?
        for message in messages {
            let day = calendar.startOfDay(for: message.createdAt)
            if day != currentDay {
                result.append(.day(day))
                currentDay = day
            }
            result.append(.message(message))
        }
        return result
    }

    // MARK: - Data

    private func pollLoop() async {
        await refresh()
        await markRead()
        while !Task.isCancelled {
            try? await Task.sleep(for: Self.pollInterval)
            guard !Task.isCancelled else { return }
            let lastIncoming = messages.last { $0.role == .user }?.id
            await refresh()
            if messages.last(where: { $0.role == .user })?.id != lastIncoming {
                await markRead()
            }
        }
    }

    private func refresh() async {
        do {
            let latest = try await api.chatMessages(chatId: chat.chatId, limit: Self.pageSize)
            let previousLastId = messages.last?.id
            if !hasLoaded { hasEarlier = latest.count >= Self.pageSize }
            messages = merge(messages, latest)
            hasLoaded = true
            loadError = nil
            if messages.last?.id != previousLastId {
                withAnimation(.smooth) { position.scrollTo(edge: .bottom) }
            }
        } catch is CancellationError {
            return
        } catch {
            if !hasLoaded { loadError = error.userMessage }
        }
    }

    private func loadEarlier() async {
        guard let firstId = messages.first?.id else { return }
        isLoadingEarlier = true
        defer { isLoadingEarlier = false }
        do {
            let earlier = try await api.chatMessages(chatId: chat.chatId, beforeId: firstId, limit: Self.pageSize)
            hasEarlier = earlier.count >= Self.pageSize
            messages = merge(earlier, messages)
        } catch {
            errorMessage = error.userMessage
        }
    }

    private func merge(_ lhs: [BotMessage], _ rhs: [BotMessage]) -> [BotMessage] {
        var byId: [Int: BotMessage] = [:]
        for message in lhs + rhs { byId[message.id] = message }
        return byId.values.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
    }

    private func markRead() async {
        do {
            try await api.markChatRead(chatId: chat.chatId)
            chat.unreadCount = 0
            chat.needsAttention = false
            onChange?(chat)
            await appState.refreshBadges()
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.userMessage
        }
    }

    private func send() {
        let text = draft.trimmed
        guard !text.isEmpty else { return }
        isSending = true
        Task {
            defer { isSending = false }
            do {
                let sent = try await api.sendChatMessage(chatId: chat.chatId, text: text)
                draft = ""
                messages = merge(messages, [sent])
                chat.lastMessage = sent
                chat.needsAttention = false
                onChange?(chat)
                sentCount += 1
                withAnimation(.smooth) { position.scrollTo(edge: .bottom) }
            } catch {
                errorMessage = error.userMessage
            }
        }
    }

    /// The chat stays open as an ordinary client chat; the list gets the change.
    private func employeeUnlinked() {
        chat.employee = nil
        onChange?(chat)
        unlinkedCount += 1
    }

    /// The chat is now the employee's staff chat: the banner shows, the bot's greeting appears in the conversation.
    private func employeeBound(_ updated: BotChat) {
        chat = updated
        onChange?(chat)
        boundCount += 1
        Task { await refresh() }
    }

    private func toggleAI() {
        isTogglingAI = true
        Task {
            defer { isTogglingAI = false }
            do {
                chat = try await api.setChatAIPaused(chatId: chat.chatId, paused: !chat.aiPaused)
                onChange?(chat)
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        ChatView(chat: PreviewData.chat)
    }
    .previewEnvironment()
}

#Preview("Чат сотрудника") {
    NavigationStack {
        ChatView(chat: PreviewData.staffChat)
    }
    .previewEnvironment()
}
#endif
