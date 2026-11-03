import SwiftUI

/// Platforms of the selected profile (the «Площадки» part of Titan `settings.tsx`): its Telegram channel the marketer
/// posts to, Instagram (posted by the API or by a person), VK and sites for links and numbers. Add, open to rename,
/// recheck the channel, switch off or delete. The author's platforms are her own, separate from the studio's.
struct SmmAccountsView: View {
    @Environment(APIClient.self) private var api
    @Environment(SmmProfileStore.self) private var store
    @State private var remote = Remote<SmmSettingsPayload>()
    @State private var instagram: SmmInstagram?
    @State private var adding: SmmAccountAddTarget?
    @State private var pendingDelete: SmmAccount?
    @State private var busyIds: Set<String> = []
    @State private var notice: SmmAccountNotice?
    @State private var errorMessage: String?
    @State private var savedCount = 0

    private var profile: SmmProfile { store.profile }
    private var brand: String { store.title(of: profile) }
    private var accounts: [SmmAccount] { remote.value?.accounts ?? [] }

    var body: some View {
        List {
            if remote.value != nil {
                accountsSection
                addSection
            }
        }
        .overlay {
            if remote.value == nil { RemoteStateOverlay(remote: remote, retry: load) }
        }
        .auraBackground()
        .navigationTitle("Площадки")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                addMenu {
                    Label("Добавить площадку", systemImage: "plus")
                }
                .disabled(remote.value == nil)
            }
        }
        .refreshable { await load() }
        .task(id: profile) { await load() }
        .onAppear {
            // Back from the Instagram screen: its status may have changed.
            if remote.value != nil { Task { await loadInstagram() } }
        }
        .remoteErrorAlert(remote)
        .errorAlert($errorMessage, title: "Не получилось")
        .sensoryFeedback(.success, trigger: savedCount)
        .sheet(item: $adding) { target in
            SmmAccountAddSheet(profile: profile, brand: brand, platform: target.platform) { payload in
                applyAdded(payload)
            }
        }
        .alert(
            notice?.title ?? "",
            isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } }),
            presenting: notice
        ) { _ in
            Button("Понятно", role: .cancel) {}
        } message: { notice in
            Text(notice.message)
        }
        .confirmationDialog(
            "Удалить площадку?",
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            titleVisibility: .visible,
            presenting: pendingDelete
        ) { account in
            Button("Удалить «\(account.title)»", role: .destructive) { delete(account) }
            Button("Отмена", role: .cancel) {}
        } message: { account in
            Text(account.platform == .telegram
                ? "Маркетолог перестанет публиковать в этот канал. Вышедшие посты и их цифры останутся."
                : "Маркетолог перестанет собирать цифры этой площадки.")
        }
    }

    // MARK: Sections

    private var accountsSection: some View {
        Section {
            ForEach(accounts) { account in
                NavigationLink {
                    SmmAccountDetailView(profile: profile, brand: brand, account: account) { payload in
                        remote.set(payload)
                    }
                } label: {
                    SmmAccountRow(account: account, isBusy: busyIds.contains(account.id))
                }
                .swipeActions(edge: .trailing) {
                    Button("Удалить", systemImage: "trash") { pendingDelete = account }
                        .tint(.red)
                    Button(account.isActive ? "Выключить" : "Включить", systemImage: account.isActive ? "pause" : "play") {
                        setActive(account, !account.isActive)
                    }
                    .tint(account.isActive ? .gray : .green)
                }
                .contextMenu {
                    if account.platform == .telegram {
                        Button("Проверить права", systemImage: "checkmark.shield") { check(account) }
                    }
                    Button(account.isActive ? "Выключить" : "Включить", systemImage: account.isActive ? "pause" : "play") {
                        setActive(account, !account.isActive)
                    }
                    Button("Удалить", systemImage: "trash", role: .destructive) { pendingDelete = account }
                }
            }
            NavigationLink(value: SmmRoute.instagram) {
                instagramRow
            }
        } header: {
            Text(profile == .author ? "Площадки \(brand)" : "Площадки студии")
        } footer: {
            Text(footer)
        }
    }

    private var instagramRow: some View {
        HStack(spacing: 12) {
            SmmPlatformBadge(SmmAccountPlatform.instagram, size: 32)
                .saturation(instagram?.connected == true ? 1 : 0)
            VStack(alignment: .leading, spacing: 2) {
                Text("Instagram по API")
                Text(instagramStatus)
                    .font(.footnote)
                    .foregroundStyle(instagram?.state?.error == nil ? Color.secondary : Color.orange)
                    .lineLimit(2)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var instagramStatus: String {
        guard let state = instagram?.state else { return "Подключить официально — маркетолог будет выкладывать сам" }
        if let error = state.error.nonEmpty { return error }
        return "@\(state.username) · маркетолог выкладывает сам"
    }

    private var footer: String {
        let main = "В канал Telegram маркетолог публикует сам. В Instagram — тоже сам, если он подключён по API; иначе "
            + "маркетолог присылает файлы и текст человеку и ждёт ссылку. Цифры — по API площадок: свежие посты каждый час, "
            + "остальное раз в день."
        return profile == .author ? "Это площадки \(brand) — свои, отдельные от студии. " + main : main
    }

    @ViewBuilder
    private var addSection: some View {
        let hasTelegram = accounts.contains { $0.platform == .telegram }
        let hasInstagram = accounts.contains { $0.platform == .instagram }
        Section {
            if !hasTelegram {
                Button("Подключить канал Telegram", systemImage: "paperplane") { adding = SmmAccountAddTarget(platform: .telegram) }
            }
            if !hasInstagram {
                Button("Добавить Instagram", systemImage: "camera") { adding = SmmAccountAddTarget(platform: .instagram) }
            }
            addMenu {
                Label("Добавить другую площадку", systemImage: "plus")
            }
        }
    }

    private func addMenu<MenuLabel: View>(@ViewBuilder label: () -> MenuLabel) -> some View {
        let menuLabel = label()
        return Menu {
            Button(accounts.contains { $0.platform == .telegram } ? "Ещё канал Telegram" : "Канал Telegram", systemImage: "paperplane") {
                adding = SmmAccountAddTarget(platform: .telegram)
            }
            Button("Instagram", systemImage: "camera") { adding = SmmAccountAddTarget(platform: .instagram) }
            Button("ВКонтакте", systemImage: "person.2") { adding = SmmAccountAddTarget(platform: .vk) }
            Button("Сайт или другое", systemImage: "link") { adding = SmmAccountAddTarget(platform: .other) }
        } label: {
            menuLabel
        }
    }

    // MARK: Actions

    private func applyAdded(_ payload: SmmSettingsPayload) {
        let before = Set(accounts.map(\.id))
        remote.set(payload)
        savedCount += 1
        let added = payload.accounts.first { !before.contains($0.id) && $0.platform == .telegram && !$0.canPublish }
        if let added, let problem = added.statsError.nonEmpty {
            notice = SmmAccountNotice(title: "Канал добавлен, но…", message: problem)
        }
    }

    private func setActive(_ account: SmmAccount, _ isActive: Bool) {
        run(account) { try await api.updateSmmAccount(profile, id: account.id, SmmAccountPatch(isActive: isActive)) }
    }

    private func check(_ account: SmmAccount) {
        run(account) { try await api.checkSmmAccount(profile, id: account.id) }
    }

    private func delete(_ account: SmmAccount) {
        run(account) { try await api.deleteSmmAccount(profile, id: account.id) }
    }

    private func run(_ account: SmmAccount, _ operation: @escaping () async throws -> SmmSettingsPayload) {
        busyIds.insert(account.id)
        Task {
            defer { busyIds.remove(account.id) }
            do {
                let payload = try await operation()
                withAnimation { remote.set(payload) }
                savedCount += 1
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
    }

    private func load() async {
        let profile = profile
        async let instagramLoad: Void = loadInstagram()
        await remote.load { try await api.smmSettings(profile) }
        await instagramLoad
    }

    private func loadInstagram() async {
        do {
            instagram = try await api.smmInstagram(profile)
        } catch {
            // The row then offers to connect; the Instagram screen shows the failure itself.
            instagram = nil
        }
    }
}

/// Which platform the add sheet is for.
struct SmmAccountAddTarget: Identifiable, Hashable {
    let platform: SmmAccountPlatform

    var id: String { platform.rawValue }
}

/// A heads-up after adding (the channel is added, but the bot cannot post yet).
struct SmmAccountNotice: Identifiable {
    let title: String
    let message: String

    var id: String { title + message }
}

/// Row of a platform: its badge, title and what the marketer can do there.
struct SmmAccountRow: View {
    let account: SmmAccount
    var isBusy = false

    var body: some View {
        HStack(spacing: 12) {
            SmmPlatformBadge(account.platform, size: 32)
                .saturation(account.isActive ? 1 : 0)
            VStack(alignment: .leading, spacing: 2) {
                Text(account.title.nonEmpty ?? account.platform.title)
                    .lineLimit(1)
                Text(status)
                    .font(.footnote)
                    .foregroundStyle(statusColor)
                    .lineLimit(1)
                if account.isActive, let problem = account.statsError.nonEmpty {
                    Text(problem)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if isBusy {
                ProgressView()
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var needsRights: Bool { account.platform == .telegram && !account.canPublish }

    private var status: String {
        guard account.isActive else { return "Выключена" }
        if account.platform == .telegram {
            return account.canPublish ? "Маркетолог публикует" : "Нет прав на публикацию"
        }
        if let followers = account.followers {
            return "\(SmmText.count(followers)) подписчиков"
        }
        return account.handle.nonEmpty.map { "@\($0)" } ?? account.url ?? account.platform.title
    }

    private var statusColor: Color {
        account.isActive && needsRights ? .orange : .secondary
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        SmmAccountsView()
    }
    .environment(SmmProfileStore())
    .previewEnvironment()
}
#endif
