import SwiftUI

/// A campaign: its message and audience, delivery stats (refreshed while it sends) and what can be done with it —
/// edit, test, send now or later, stop, delete a draft.
struct CampaignDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    @Environment(ReferenceStore.self) private var reference

    let campaignId: Int
    let onChange: (CampaignChange) -> Void

    @State private var campaign: Remote<Campaign>
    @State private var audience: CampaignAudience?
    @State private var showsEditor = false
    @State private var showsSchedule = false
    @State private var confirmation: CampaignConfirmation?
    @State private var isWorking = false
    @State private var notice: String?
    @State private var errorMessage: String?

    /// The longest pause between refreshes after failures.
    private static let maxPollInterval = Duration.seconds(60)

    init(campaignId: Int, initial: Campaign?, onChange: @escaping (CampaignChange) -> Void) {
        self.campaignId = campaignId
        self.onChange = onChange
        _campaign = State(initialValue: Remote(initial))
    }

    /// How often the card asks again: stats while sending, the start of a scheduled one; `nil` — never.
    private var pollInterval: Duration? { campaign.value.flatMap { CampaignRefresh.interval(for: $0.status) } }
    /// Nobody matches the conditions now: the server refuses to send.
    private var hasNoRecipients: Bool { audience?.count == 0 }

    var body: some View {
        List {
            if let current = campaign.value {
                CampaignHeaderSection(campaign: current)
                if current.status.canSend {
                    CampaignAudienceSection(segment: current.segment, audience: $audience)
                } else if current.status != .draft {
                    CampaignStatsSection(stats: current.stats, status: current.status)
                }
                actionsSection(current)
                Section("Сообщение") {
                    TelegramMessagePreview(
                        text: current.text,
                        imagePath: current.imageUrl,
                        buttons: CampaignPresentation.buttons(current.button),
                        name: CampaignText.previewName(audience?.sample.first)
                    )
                    .padding(.vertical, 6)
                }
                CampaignSegmentSummarySection(segment: current.segment)
            }
        }
        .overlay {
            if campaign.value == nil {
                RemoteStateOverlay(remote: campaign, retry: load)
            }
        }
        .navigationTitle("Рассылка")
        .navigationBarTitleDisplayMode(.inline)
        .disabled(isWorking)
        .refreshable { await load() }
        .task { await load() }
        // Masters of the segment are named from the staff list; without it the lines read «мастер №2».
        .task { try? await reference.ensureEmployees() }
        .task(id: pollInterval) { await poll() }
        .remoteErrorAlert(campaign)
        .errorAlert($errorMessage)
        .errorAlert($notice, title: "Готово")
        .sheet(isPresented: $showsEditor) {
            if let current = campaign.value {
                CampaignEditorView(campaign: current) { saved in apply(saved) }
            }
        }
        .sheet(isPresented: $showsSchedule) {
            CampaignScheduleSheet(current: campaign.value?.scheduledAt, recipients: audience?.count) { date in
                send(at: date)
            }
        }
        .confirmationDialog(
            confirmation?.title ?? "",
            isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }),
            titleVisibility: .visible,
            presenting: confirmation
        ) { action in
            Button(action.buttonTitle, role: action.isDestructive ? .destructive : nil) { perform(action) }
            Button("Не сейчас", role: .cancel) {}
        } message: { action in
            Text(action.message)
        }
    }

    @ViewBuilder
    private func actionsSection(_ current: Campaign) -> some View {
        let status = current.status
        Section {
            if status.isEditable {
                Button("Изменить", systemImage: "pencil") { showsEditor = true }
            }
            if status != .unknown {
                Button("Отправить тест себе", systemImage: "paperplane") { sendTest() }
            }
            if status.canSend {
                Button("Отправить сейчас", systemImage: "paperplane.fill") {
                    confirmation = .sendNow(recipients: audience?.count)
                }
                .disabled(hasNoRecipients)
                Button(status == .scheduled ? "Перенести" : "Запланировать", systemImage: "calendar.badge.clock") {
                    showsSchedule = true
                }
            }
            if status.canCancel {
                Button(status == .sending ? "Остановить рассылку" : "Отменить отправку", systemImage: "stop.circle", role: .destructive) {
                    confirmation = .cancel(isSending: status == .sending)
                }
            }
            if status.canDelete {
                Button("Удалить черновик", systemImage: "trash", role: .destructive) {
                    confirmation = .delete
                }
            }
        } footer: {
            if status.canSend && hasNoRecipients {
                Text("Под условия сейчас никто не подходит — измените условия или запланируйте рассылку на потом.")
            } else if status.canSend {
                Text("Тест придёт в ваш рабочий чат с ботом. Отправка идёт в фоне — экран можно закрыть.")
            } else if status == .sending {
                Text("Статистика обновляется сама. Уже отправленные сообщения останутся у клиентов.")
            }
        }
    }

    // MARK: - Data

    private func load() async {
        await campaign.load { try await fetch() }
    }

    /// There is no `GET /campaigns/:id`: the card finds itself in the list.
    private func fetch() async throws -> Campaign {
        let items = try await api.campaigns()
        guard let found = items.first(where: { $0.id == campaignId }) else {
            throw CampaignLookupError.notFound
        }
        return found
    }

    /// Refreshes the card while it sends (or waits to start) until the status changes — then `.task(id:)` restarts it
    /// with the new interval. A failed refresh keeps the last numbers without an alert (one every few seconds on a bad
    /// network would be noise) and waits twice as long before the next try; a deleted campaign stops it.
    private func poll() async {
        guard var interval = pollInterval else { return }
        let regular = interval
        while !Task.isCancelled {
            do {
                try await Task.sleep(for: interval)
                apply(try await fetch())
                interval = regular
            } catch is CancellationError {
                return
            } catch let error as CampaignLookupError {
                campaign.transientError = error.userMessage
                return
            } catch {
                interval = min(interval * 2, Self.maxPollInterval)
            }
        }
    }

    private func apply(_ updated: Campaign) {
        campaign.set(updated)
        onChange(.updated(updated))
    }

    // MARK: - Actions

    private func perform(_ action: CampaignConfirmation) {
        switch action {
        case .sendNow: send(at: nil)
        case .cancel: cancel()
        case .delete: delete()
        }
    }

    private func run(_ operation: @escaping @MainActor () async throws -> Void) {
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                try await operation()
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
    }

    private func sendTest() {
        run {
            try await api.testCampaign(id: campaignId)
            notice = "Тестовое сообщение отправлено в ваш рабочий чат."
        }
    }

    private func send(at date: Date?) {
        run { apply(try await api.sendCampaign(id: campaignId, at: date)) }
    }

    private func cancel() {
        run { apply(try await api.cancelCampaign(id: campaignId)) }
    }

    private func delete() {
        run {
            try await api.deleteCampaign(id: campaignId)
            onChange(.deleted(campaignId))
            dismiss()
        }
    }
}

/// How often an open campaign card refreshes itself.
nonisolated enum CampaignRefresh {
    /// Stats while sending.
    static let sending = Duration.seconds(3)
    /// A scheduled campaign, to notice that it started.
    static let scheduled = Duration.seconds(15)

    static func interval(for status: CampaignStatus) -> Duration? {
        switch status {
        case .sending: sending
        case .scheduled: scheduled
        case .draft, .sent, .cancelled, .unknown: nil
        }
    }
}

nonisolated enum CampaignLookupError: LocalizedError {
    case notFound

    var errorDescription: String? { "Рассылка не найдена — возможно, её удалили." }
}

/// Actions on a campaign that ask first.
enum CampaignConfirmation {
    case sendNow(recipients: Int?)
    case cancel(isSending: Bool)
    case delete

    var title: String {
        switch self {
        case .sendNow(let recipients?):
            recipients == 0 ? "Подходящих клиентов нет" : "Отправить \(CampaignPresentation.clientsDative(recipients))?"
        case .sendNow(nil): "Отправить рассылку?"
        case .cancel(let isSending): isSending ? "Остановить рассылку?" : "Отменить отправку?"
        case .delete: "Удалить черновик?"
        }
    }

    var message: String {
        switch self {
        case .sendNow(let recipients):
            recipients == 0
                ? "Сейчас под условия никто не подходит — измените условия рассылки."
                : "Сообщение уйдёт клиентам в Telegram сразу. Отменить уже отправленные сообщения нельзя."
        case .cancel(let isSending):
            isSending
                ? "Оставшиеся сообщения не уйдут. Те, что уже отправлены, останутся у клиентов."
                : "Рассылка не будет отправлена. Вернуть её в работу будет нельзя."
        case .delete:
            "Черновик удалится насовсем."
        }
    }

    var buttonTitle: String {
        switch self {
        case .sendNow: "Отправить"
        case .cancel(let isSending): isSending ? "Остановить" : "Отменить отправку"
        case .delete: "Удалить"
        }
    }

    var isDestructive: Bool {
        if case .sendNow = self { return false }
        return true
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        CampaignDetailView(campaignId: 1, initial: PreviewData.campaign) { _ in }
    }
    .previewEnvironment()
}
#endif
