import SwiftUI

/// Instagram of the selected profile by the official API (Titan `instagram.tsx`): with it the marketer takes the numbers
/// and links and posts approved posts, carousels, reels and stories by itself. Connected with a key from the Meta
/// dashboard (the Instagram sign-in happens there — the password never reaches MIKAN). The author connects her own
/// Instagram, separately from the studio's.
struct SmmInstagramView: View {
    @Environment(APIClient.self) private var api
    @Environment(SmmProfileStore.self) private var store
    @State private var remote = Remote<SmmInstagram>()
    @State private var token = ""
    @State private var isConnecting = false
    @State private var isDisconnecting = false
    @State private var confirmsDisconnect = false
    @State private var connected: SmmInstagramState?
    @State private var errorMessage: String?
    @State private var savedCount = 0

    /// Meta's keys are long; a shorter paste is a part of one.
    private static let minimumTokenLength = 40
    private static let maximumTokenLength = 1000
    private static let metaAppsURL = URL(string: "https://developers.facebook.com/apps")
    private static let secondsPerDay: Double = 86_400

    private var profile: SmmProfile { store.profile }
    private var brand: String { store.title(of: profile) }
    private var state: SmmInstagramState? { remote.value?.state }
    private var canConnect: Bool { !isConnecting && token.trimmed.count >= Self.minimumTokenLength }

    var body: some View {
        Form {
            if remote.value != nil {
                statusSection
                stepsSection
                tokenSection
            }
        }
        .overlay {
            if remote.value == nil { RemoteStateOverlay(remote: remote, retry: load) }
        }
        .auraBackground()
        .navigationTitle("Instagram API")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: profile) { await load() }
        .remoteErrorAlert(remote)
        .errorAlert($errorMessage, title: "Не получилось")
        .sensoryFeedback(.success, trigger: savedCount)
        .alert(
            "Instagram подключён",
            isPresented: Binding(get: { connected != nil }, set: { if !$0 { connected = nil } }),
            presenting: connected
        ) { _ in
            Button("Хорошо", role: .cancel) {}
        } message: { state in
            Text("@\(state.username): маркетолог теперь сам берёт цифры и выкладывает одобренные публикации.")
        }
        .confirmationDialog("Отключить Instagram?", isPresented: $confirmsDisconnect, titleVisibility: .visible) {
            Button("Отключить", role: .destructive, action: disconnect)
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Маркетолог перестанет выкладывать сам — будет снова присылать файлы человеку.")
        }
    }

    // MARK: Sections

    private var statusSection: some View {
        Section {
            HStack(spacing: 14) {
                SmmPlatformBadge(SmmAccountPlatform.instagram, size: 44)
                    .saturation(state == nil ? 0 : 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.map { "@\($0.username)" } ?? "Не подключён")
                        .font(.headline)
                    Text(statusText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
            if let state {
                if let error = state.error.nonEmpty {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
                if let name = state.name.nonEmpty {
                    LabeledContent("Имя", value: name)
                }
                if let type = state.accountType.nonEmpty {
                    LabeledContent("Тип аккаунта", value: Self.accountTypeTitle(type))
                }
                LabeledContent("Ключ подключён", value: Self.dateText(state.tokenSetAt))
                LabeledContent("Действует до", value: Self.dateText(state.expiresAt))
                Button(role: .destructive) {
                    confirmsDisconnect = true
                } label: {
                    HStack {
                        Label("Отключить", systemImage: "xmark")
                        if isDisconnecting {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(isDisconnecting || isConnecting)
            }
        } header: {
            Text(profile == .author ? "Instagram \(brand)" : "Instagram студии")
        } footer: {
            if profile == .author {
                Text("Личный Instagram \(brand) подключается отдельно от студийного и работает только в её профиле.")
            }
        }
    }

    private var statusText: String {
        guard let state else { return "Сейчас маркетолог присылает файлы и текст человеку и ждёт ссылку." }
        let days = max(0, Int((state.expiresAt.timeIntervalSinceNow / Self.secondsPerDay).rounded()))
        return "Маркетолог выкладывает сам и берёт цифры. Ключ ещё \(days) дн., продлевается сам."
    }

    private var stepsSection: some View {
        Section(state == nil ? "Как подключить" : "Заменить ключ") {
            step(1, "Профессиональный аккаунт",
                 "В Instagram: Настройки → «Тип аккаунта и инструменты» → «Переключиться на профессиональный» (Бизнес или Автор). Бесплатно.")
            VStack(alignment: .leading, spacing: 8) {
                step(2, "Приложение Meta",
                     "На developers.facebook.com → «Мои приложения» → «Создать приложение». Сценарий — «Управлять сообщениями и контентом в Instagram», тип — «Бизнес».")
                if let url = Self.metaAppsURL {
                    Link(destination: url) {
                        Label("Открыть кабинет Meta", systemImage: "safari")
                            .font(.subheadline)
                    }
                    .padding(.leading, 34)
                }
            }
            step(3, profile == .author ? "Добавить Instagram \(brand)" : "Добавить аккаунт студии",
                 "В приложении: Instagram → «Настройка API со входом через Instagram» → «Добавить аккаунт» и войдите в "
                     + (profile == .author ? "личный Instagram \(brand)" : "Instagram студии")
                     + ". Если попросят подтвердить приглашение тестировщика — в Instagram: Настройки → «Приложения и сайты».")
            step(4, "Получить ключ",
                 "Там же нажмите «Сгенерировать токен» рядом с аккаунтом, разрешите доступ и скопируйте ключ целиком. Он действует 60 дней — дальше маркетолог продлевает его сам.")
            step(5, "Вставить сюда",
                 "Вставьте ключ в поле ниже и нажмите «Подключить». Если кабинет Meta у вас открывается только с VPN — включите его на телефоне.")
        }
    }

    private func step(_ number: Int, _ title: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.footnote.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Color.accentColor, in: .circle)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.headline)
                Text(text)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var tokenSection: some View {
        Section {
            TextField("Ключ доступа (начинается с IG…)", text: $token, axis: .vertical)
                .lineLimit(3...6)
                .font(.body.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .disabled(isConnecting)
                .accessibilityLabel("Ключ доступа Instagram")
                .onChange(of: token) { _, value in
                    if value.count > Self.maximumTokenLength { token = String(value.prefix(Self.maximumTokenLength)) }
                }
            Button(action: connect) {
                HStack {
                    Label("Подключить", systemImage: "link")
                    if isConnecting {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(!canConnect || isDisconnecting)
        } footer: {
            Label("Ключ хранится на сервере MIKAN зашифрованным и никому не показывается. Пароль от Instagram приложение не видит.", systemImage: "lock.fill")
        }
    }

    // MARK: Actions

    private func connect() {
        let key = token.trimmed
        let profile = profile
        isConnecting = true
        Task {
            defer { isConnecting = false }
            do {
                let result = try await api.connectSmmInstagram(profile, token: key)
                remote.set(result)
                token = ""
                savedCount += 1
                connected = result.state
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
    }

    private func disconnect() {
        let profile = profile
        isDisconnecting = true
        Task {
            defer { isDisconnecting = false }
            do {
                remote.set(try await api.disconnectSmmInstagram(profile))
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
        await remote.load { try await api.smmInstagram(profile) }
    }

    private static func dateText(_ date: Date) -> String {
        date.formatted(.dateTime.day().month(.wide).year().locale(.app))
    }

    private static func accountTypeTitle(_ type: String) -> String {
        switch type.uppercased() {
        case "BUSINESS": "Бизнес"
        case "MEDIA_CREATOR", "CREATOR": "Автор"
        case "PERSONAL": "Личный"
        default: type
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        SmmInstagramView()
    }
    .environment(SmmProfileStore())
    .previewEnvironment()
}
#endif
