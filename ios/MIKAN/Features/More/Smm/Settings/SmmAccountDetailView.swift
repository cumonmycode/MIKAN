import SwiftUI

/// The bot every profile's channel needs as an admin with posting rights (docs/SMM.md, «Telegram»).
nonisolated enum SmmChannelBot {
    static let username = "@mikan_robot"
}

/// One platform of the profile: rename, the bot's posting rights with the instruction and «Проверить»,
/// the numbers and their error, on/off and delete (Titan's account menu in `settings.tsx`).
struct SmmAccountDetailView: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    let profile: SmmProfile
    let brand: String
    let onChange: (SmmSettingsPayload) -> Void

    @State private var account: SmmAccount
    @State private var title: String
    @State private var isChecking = false
    @State private var isSaving = false
    @State private var confirmsDelete = false
    @State private var errorMessage: String?
    @State private var savedCount = 0
    @FocusState private var isTitleFocused: Bool

    private static let titleLimit = 80

    init(profile: SmmProfile, brand: String, account: SmmAccount, onChange: @escaping (SmmSettingsPayload) -> Void) {
        self.profile = profile
        self.brand = brand
        self.onChange = onChange
        _account = State(initialValue: account)
        _title = State(initialValue: account.title)
    }

    private var isTelegram: Bool { account.platform == .telegram }

    var body: some View {
        Form {
            headerSection
            Section("Название") {
                TextField(account.platform.title, text: $title)
                    .focused($isTitleFocused)
                    .submitLabel(.done)
                    .onSubmit(commitTitle)
                    .onChange(of: isTitleFocused) { _, focused in
                        if !focused { commitTitle() }
                    }
                    .onChange(of: title) { _, value in
                        if value.count > Self.titleLimit { title = String(value.prefix(Self.titleLimit)) }
                    }
            }
            if isTelegram {
                publishingSection
            }
            detailsSection
            if let problem = account.statsError.nonEmpty {
                Section("Что не так") {
                    Label(problem, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }
            }
            Section {
                Toggle("Площадка включена", isOn: Binding(get: { account.isActive }, set: setActive))
                    .disabled(isSaving)
            } footer: {
                Text(isTelegram
                    ? "Выключенный канал маркетолог не использует: не публикует в него и не собирает цифры."
                    : "У выключенной площадки маркетолог не собирает цифры.")
            }
            Section {
                Button("Удалить площадку", systemImage: "trash", role: .destructive) { confirmsDelete = true }
                    .disabled(isSaving)
            }
        }
        .auraBackground()
        .navigationTitle(account.title.nonEmpty ?? account.platform.title)
        .navigationBarTitleDisplayMode(.inline)
        .errorAlert($errorMessage, title: "Не получилось")
        .sensoryFeedback(.success, trigger: savedCount)
        .confirmationDialog("Удалить площадку?", isPresented: $confirmsDelete, titleVisibility: .visible) {
            Button("Удалить «\(account.title)»", role: .destructive, action: delete)
            Button("Отмена", role: .cancel) {}
        } message: {
            Text(isTelegram
                ? "Маркетолог перестанет публиковать в этот канал. Вышедшие посты и их цифры останутся."
                : "Маркетолог перестанет собирать цифры этой площадки.")
        }
    }

    private var headerSection: some View {
        Section {
            HStack(spacing: 14) {
                SmmPlatformBadge(account.platform, size: 44)
                    .saturation(account.isActive ? 1 : 0)
                VStack(alignment: .leading, spacing: 2) {
                    Text(account.title.nonEmpty ?? account.platform.title)
                        .font(.headline)
                    Text(profile == .author ? "\(account.platform.title) · \(brand)" : "\(account.platform.title) · студия")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var publishingSection: some View {
        Section {
            if account.canPublish {
                Label("Маркетолог публикует в канал сам", systemImage: "checkmark.seal.fill")
                    .foregroundStyle(.green)
            } else {
                Label("Нет прав на публикацию", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text("Откройте канал → «Управление каналом» → «Администраторы» → «Добавить администратора», найдите "
                    + "\(SmmChannelBot.username) и включите право «Публикация сообщений». Затем нажмите «Проверить».")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            checkButton("Проверить права")
        } header: {
            Text("Публикация")
        } footer: {
            Text("\(SmmChannelBot.username) — общий бот MIKAN: он публикует в каналы обоих профилей и присылает превью на одобрение.")
        }
    }

    private func checkButton(_ title: String) -> some View {
        Button(action: check) {
            HStack {
                Label(title, systemImage: "arrow.clockwise")
                if isChecking {
                    Spacer()
                    ProgressView()
                }
            }
        }
        .disabled(isChecking || isSaving)
    }

    private var detailsSection: some View {
        Section {
            if let url = account.url.flatMap(URL.init(string:)) {
                Link(destination: url) {
                    LabeledContent("Ссылка", value: url.host() ?? url.absoluteString)
                }
            }
            if let handle = account.handle.nonEmpty {
                LabeledContent("Имя", value: "@\(handle)")
            }
            if isTelegram, let chat = account.tgChatId.nonEmpty {
                LabeledContent("Канал", value: chat)
                    .textSelection(.enabled)
            }
            if let followers = account.followers {
                LabeledContent("Подписчики", value: SmmText.count(followers))
                    .monospacedDigit()
            }
            if let posts = account.stats.posts {
                LabeledContent("Постов", value: SmmText.count(posts))
                    .monospacedDigit()
            }
            LabeledContent("Цифры обновлены", value: account.statsAt.map(Self.dateText) ?? "Ещё нет")
            if !isTelegram {
                checkButton("Обновить цифры")
            }
        } header: {
            Text("Сведения")
        } footer: {
            Text("Цифры приходят по API площадок: свежие посты — каждый час, остальное — раз в день.")
        }
    }

    // MARK: Actions

    private func commitTitle() {
        let name = title.trimmed
        guard !name.isEmpty else {
            title = account.title
            return
        }
        guard name != account.title else { return }
        title = name
        perform { try await api.updateSmmAccount(profile, id: account.id, SmmAccountPatch(title: name)) }
    }

    private func setActive(_ isActive: Bool) {
        guard isActive != account.isActive else { return }
        perform { try await api.updateSmmAccount(profile, id: account.id, SmmAccountPatch(isActive: isActive)) }
    }

    private func check() {
        isChecking = true
        perform(onDone: { isChecking = false }) { try await api.checkSmmAccount(profile, id: account.id) }
    }

    private func delete() {
        isSaving = true
        let id = account.id
        Task {
            defer { isSaving = false }
            do {
                let payload = try await api.deleteSmmAccount(profile, id: id)
                // Back first: the list then drops the row this screen was opened from.
                dismiss()
                onChange(payload)
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
    }

    private func perform(onDone: @escaping () -> Void = {}, _ operation: @escaping () async throws -> SmmSettingsPayload) {
        isSaving = true
        let id = account.id
        Task {
            defer {
                isSaving = false
                onDone()
            }
            do {
                let payload = try await operation()
                onChange(payload)
                if let fresh = payload.accounts.first(where: { $0.id == id }) {
                    account = fresh
                    if !isTitleFocused { title = fresh.title }
                }
                savedCount += 1
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
                title = account.title
            }
        }
    }

    private static func dateText(_ date: Date) -> String {
        date.formatted(.dateTime.day().month(.wide).hour().minute().locale(.app))
    }
}

/// Adds a platform to the profile: a Telegram channel (checked at once — the bot must be its admin),
/// Instagram, VK or another site by a link or `@name`.
struct SmmAccountAddSheet: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    let profile: SmmProfile
    let brand: String
    let platform: SmmAccountPlatform
    let onAdded: (SmmSettingsPayload) -> Void

    @State private var input = ""
    @State private var title = ""
    @State private var isSaving = false
    @State private var errorMessage: String?
    @FocusState private var isInputFocused: Bool

    /// `server/src/routes/smm-settings.ts`: input 2–300, title up to 80.
    private static let inputRange = 2...300
    private static let titleLimit = 80

    private var isTelegram: Bool { platform == .telegram }
    private var canSave: Bool { !isSaving && Self.inputRange.contains(input.trimmed.count) }

    var body: some View {
        NavigationStack {
            Form {
                if isTelegram {
                    stepsSection
                }
                Section {
                    TextField(placeholder, text: $input)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($isInputFocused)
                        .submitLabel(.done)
                        .onSubmit { if canSave { save() } }
                    TextField("Название (необязательно)", text: $title)
                        .onChange(of: title) { _, value in
                            if value.count > Self.titleLimit { title = String(value.prefix(Self.titleLimit)) }
                        }
                } header: {
                    Text(isTelegram ? "Канал" : "Профиль")
                } footer: {
                    Text(footer)
                }
                if isSaving, isTelegram {
                    Section {
                        Label("Проверяем канал и собираем цифры…", systemImage: "hourglass")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .disabled(isSaving)
            .navigationTitle(navigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button(isTelegram ? "Подключить" : "Добавить", action: save)
                            .disabled(!canSave)
                    }
                }
            }
            .interactiveDismissDisabled(isSaving)
            .errorAlert($errorMessage, title: isTelegram ? "Канал не подключился" : "Не добавилось")
            .onAppear { isInputFocused = true }
        }
    }

    private var navigationTitle: String {
        switch platform {
        case .telegram: "Канал Telegram"
        case .instagram: "Instagram"
        case .vk: "ВКонтакте"
        case .other, .unknown: "Другая площадка"
        }
    }

    private var placeholder: String {
        switch platform {
        case .telegram: "t.me/имя, @имя или -100…"
        case .instagram: "instagram.com/имя или @имя"
        case .vk: "vk.com/имя"
        case .other, .unknown: "https://…"
        }
    }

    private var stepsSection: some View {
        Section("Как подключить") {
            step(1, "Откройте канал \(profile == .author ? brand : "студии") → «Управление каналом» → «Администраторы» → «Добавить администратора».")
            step(2, "Найдите \(SmmChannelBot.username) и включите право «Публикация сообщений».")
            step(3, "Вставьте ниже ссылку на канал (t.me/имя), @имя или числовой id закрытого канала (-100…).")
        }
    }

    private func step(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.footnote.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Color.accentColor, in: .circle)
                .accessibilityHidden(true)
            Text(text)
                .font(.subheadline)
        }
        .accessibilityElement(children: .combine)
    }

    private var footer: String {
        switch platform {
        case .telegram:
            "Без прав администратора маркетолог не сможет публиковать — канал добавится, а права можно дать позже и нажать «Проверить»."
        case .instagram:
            "Ссылка на профиль или @имя — для аналитики. Публикует маркетолог сам, если Instagram подключён по API; иначе присылает файлы и текст человеку."
        case .vk, .other, .unknown:
            "Ссылка на страницу или @имя — для ссылок и аналитики. Сюда маркетолог не публикует."
        }
    }

    private func save() {
        let body = SmmAccountBody(platform: platform, input: input.trimmed, title: title.trimmed.nonEmpty)
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let payload = try await api.addSmmAccount(profile, body)
                onAdded(payload)
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}
