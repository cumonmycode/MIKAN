import SwiftUI

struct ClientDetailView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppState.self) private var appState
    @Environment(\.openURL) private var openURL
    @Environment(\.permissions) private var permissions
    @Environment(\.dismiss) private var dismiss

    let clientId: Int
    var onChange: ((Client) -> Void)?
    /// «Объединить с…» done: the kept card and the cards that are gone (this one, when it was merged into another).
    var onMerged: ((ClientMergeOutcome) -> Void)?

    @State private var client: Remote<Client>
    @State private var history = Remote<ClientHistory>()
    @State private var showsEditor = false
    @State private var showsTelegramLink = false
    @State private var showsChat = false
    @State private var appointmentDraft: AppointmentDraft?
    @State private var confirmsArchive = false
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var showsMerge = false
    /// «Продать»: the client's new receipt, shown over the card.
    @State private var showsReceipt = false
    @State private var mergedAway = false

    init(
        clientId: Int,
        initial: Client? = nil,
        onChange: ((Client) -> Void)? = nil,
        onMerged: ((ClientMergeOutcome) -> Void)? = nil
    ) {
        self.clientId = clientId
        self.onChange = onChange
        self.onMerged = onMerged
        _client = State(initialValue: Remote(initial))
    }

    var body: some View {
        List {
            if let current = client.value {
                ClientHeaderSection(client: current)
                actionsSection(current)
                ClientStatsSection(stats: current.stats)
                ClientLoyaltySection(client: current) { await load() }
                infoSection(current)
                ClientMarketingSection(client: current, errorMessage: $errorMessage) { apply($0) }
                ClientHistorySection(history: history) { await loadHistory() }
                AuditHistorySection(scope: .client(id: current.id))
            }
        }
        .listSectionSpacing(.compact)
        .auraBackground()
        .overlay {
            if client.value == nil {
                RemoteStateOverlay(remote: client, retry: load)
            }
        }
        .navigationTitle(client.value?.fullName ?? "Клиент")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .disabled(isWorking)
        .refreshable { await load() }
        .task { await load() }
        .remoteErrorAlert(client)
        .errorAlert($errorMessage)
        .receiptFlow(isPresented: $showsReceipt) {
            Task { await loadHistory() }
        }
        .navigationDestination(isPresented: $showsChat) {
            if let current = client.value {
                ClientChatView(client: current.ref)
            }
        }
        .sheet(isPresented: $showsEditor) {
            if let current = client.value {
                ClientEditorView(client: current) { saved in apply(saved) }
            }
        }
        .sheet(isPresented: $showsTelegramLink) {
            TelegramLinkSheet(clientId: clientId, clientName: client.value?.name ?? "")
        }
        .sheet(isPresented: $showsMerge, onDismiss: { if mergedAway { dismiss() } }) {
            if let current = client.value {
                NavigationStack {
                    ClientMergeSearchView(client: current) { finishMerge($0) }
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Отмена", role: .cancel) { showsMerge = false }
                            }
                        }
                }
            }
        }
        .sheet(item: $appointmentDraft) { draft in
            AppointmentEditorView(draft: draft) { _ in
                Task { await loadHistory() }
            }
        }
        .confirmationDialog(
            client.value?.archived == true ? "Вернуть клиента из архива?" : "Отправить клиента в архив?",
            isPresented: $confirmsArchive,
            titleVisibility: .visible
        ) {
            if client.value?.archived == true {
                Button("Вернуть из архива") { setArchived(false) }
            } else {
                Button("В архив", role: .destructive) { setArchived(true) }
            }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("История визитов и покупок сохранится.")
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("Изменить", systemImage: "pencil") { showsEditor = true }
                if permissions.mergesClients {
                    Button("Объединить с…", systemImage: "arrow.triangle.merge") { showsMerge = true }
                }
                Button(
                    client.value?.archived == true ? "Вернуть из архива" : "В архив",
                    systemImage: client.value?.archived == true ? "tray.and.arrow.up" : "archivebox",
                    role: client.value?.archived == true ? nil : .destructive
                ) {
                    confirmsArchive = true
                }
            } label: {
                Label("Действия", systemImage: "ellipsis")
            }
            .disabled(client.value == nil)
        }
    }

    private func actionsSection(_ current: Client) -> some View {
        Section {
            GlassEffectContainer(spacing: 10) {
                HStack(spacing: 10) {
                    Button {
                        if let url = PhoneText.callURL(current.phone) { openURL(url) }
                    } label: {
                        ActionLabel(title: "Позвонить", systemImage: "phone.fill")
                    }
                    .disabled(PhoneText.callURL(current.phone) == nil)

                    Button {
                        appointmentDraft = .new(day: .now, client: current.ref)
                    } label: {
                        ActionLabel(title: "Записать", systemImage: "calendar.badge.plus")
                    }

                    Button {
                        startSale(for: current.ref)
                    } label: {
                        ActionLabel(title: "Продать", systemImage: "cart.fill")
                    }

                    Button {
                        if current.telegramLinked { showsChat = true } else { showsTelegramLink = true }
                    } label: {
                        ActionLabel(
                            title: current.telegramLinked ? "Открыть чат" : "Подключить бота",
                            systemImage: current.telegramLinked ? "bubble.left.and.bubble.right.fill" : "qrcode"
                        )
                    }
                }
                .buttonStyle(.glass)
            }
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
    }

    private func infoSection(_ current: Client) -> some View {
        Section("О клиенте") {
            if let notes = current.notes.nonEmpty {
                Text(notes)
            }
            if let telegram = current.telegramHandle {
                LabeledContent("Telegram") {
                    if let url = URL(string: "https://t.me/\(telegram)") {
                        Link("@\(telegram)", destination: url)
                    } else {
                        Text("@\(telegram)")
                    }
                }
            }
            if let instagram = current.instagram.nonEmpty {
                LabeledContent("Instagram", value: "@\(instagram)")
            }
            if let birthday = Birthday(current.birthday) {
                LabeledContent("Дата рождения", value: birthday.text)
            } else {
                ClientBirthdayHint { showsEditor = true }
            }
            if let source = current.source.nonEmpty {
                LabeledContent("Откуда узнал", value: ClientSource.title(for: source))
            }
            LabeledContent("Сообщения от бота", value: current.botEnabled ? "Включены" : "Выключены")
            LabeledContent("Клиент с", value: DateText.fullDate(current.createdAt))
        }
    }

    // MARK: - Data

    private func load() async {
        await client.load { try await api.client(id: clientId) }
        await loadHistory()
    }

    private func loadHistory() async {
        await history.load { try await api.clientHistory(id: clientId) }
    }

    private func apply(_ updated: Client) {
        var merged = updated.stats == nil ? withStats(updated, from: client.value) : updated
        // An edit answers without the bonuses: keep the ones shown.
        if merged.loyalty == nil { merged.loyalty = client.value?.loyalty }
        client.set(merged)
        onChange?(merged)
    }

    private func withStats(_ updated: Client, from previous: Client?) -> Client {
        var result = updated
        result.stats = previous?.stats
        return result
    }

    /// After «Объединить с…»: this card shows the merged result, or — merged into another — the screen closes.
    private func finishMerge(_ outcome: ClientMergeOutcome) {
        mergedAway = outcome.removedIds.contains(clientId)
        showsMerge = false
        onMerged?(outcome)
        guard !mergedAway else { return }
        errorMessage = outcome.failure
        apply(outcome.kept)
        Task { await loadHistory() }
    }

    /// «Продать»: a new open receipt for the client, shown over the card.
    private func startSale(for client: ClientRef) {
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                try await appState.startSale(for: client)
                showsReceipt = true
            } catch {
                errorMessage = error.userMessage
            }
        }
    }

    private func setArchived(_ archived: Bool) {
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                apply(try await api.setClientArchived(id: clientId, archived: archived))
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        ClientDetailView(clientId: 1, initial: PreviewData.ivan)
    }
    .previewEnvironment()
}
#endif
