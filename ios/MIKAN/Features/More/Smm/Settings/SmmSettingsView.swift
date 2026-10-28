import SwiftUI

/// Settings of the selected SMM profile (Titan `settings.tsx` plus MIKAN's fields): whether the profile is run and
/// under what name, autopilot, voice, audience, goals and directions, how much a week, the default time and how early
/// a post is prepared, who approves and who posts by hand, the AI budget. As in Titan, every change is saved at once
/// (steppers — after a short pause); the switcher on the SMM home picks up the name and the on/off flag.
/// The author's profile is separate content with its own settings, unrelated to the studio's work.
struct SmmSettingsView: View {
    @Environment(APIClient.self) private var api
    @Environment(SmmProfileStore.self) private var store
    @State private var remote = Remote<SmmSettingsPayload>()
    @State private var people = Remote<[SmmPerson]>()
    /// The settings on screen: changed at once, sent to the server one change after another.
    @State private var settings: SmmSettings?
    @State private var brandName = ""
    @State private var editing: SmmSettingsTextField?
    @State private var pendingSaves = 0
    @State private var lastSave: Task<Void, Never>?
    @State private var cadenceSave: Task<Void, Never>?
    @State private var isCadencePending = false
    @State private var errorMessage: String?
    @State private var savedCount = 0
    @FocusState private var isBrandFocused: Bool

    private static let leadHours = [6, 12, 24, 48, 72]
    private static let budgets = [0, 1000, 2000, 3000, 5000, 10000, 20000]
    private static let cadenceDebounce: Duration = .milliseconds(700)
    /// Below this Polza balance, ₽, the balance is shown in orange.
    private static let lowBalance = 300.0
    private static let brandNameLimit = 80
    /// The last default time offered: 23:30.
    private static let lastPostMinute = 23 * 60 + 30

    private var profile: SmmProfile { store.profile }
    private var isAuthor: Bool { profile == .author }
    private var brand: String { settings?.brandName.nonEmpty ?? store.title(of: profile) }

    var body: some View {
        Form {
            if let settings, let payload = remote.value {
                profileSection(settings)
                platformsSection(payload)
                voiceSection(settings)
                cadenceSection(settings)
                publishingSection(settings)
                approversSection(settings)
                publisherSection(settings)
                knowledgeSection
                budgetSection(settings, payload: payload)
            }
        }
        .overlay {
            if settings == nil { RemoteStateOverlay(remote: remote, retry: load) }
        }
        .auraBackground()
        .navigationTitle("Настройки")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if pendingSaves > 0 || isCadencePending {
                ToolbarItem(placement: .topBarTrailing) {
                    ProgressView()
                        .accessibilityLabel("Сохраняется")
                }
            }
        }
        .refreshable { await load() }
        .task(id: profile) { await load() }
        .remoteErrorAlert(remote)
        .errorAlert($errorMessage, title: "Не сохранилось")
        .sensoryFeedback(.success, trigger: savedCount)
        .sheet(item: $editing) { field in
            editor(field)
        }
    }

    // MARK: Sections

    private func profileSection(_ settings: SmmSettings) -> some View {
        Section {
            Toggle("Вести этот профиль", isOn: binding(\.enabled, in: settings) { SmmSettingsPatch(enabled: $0) })
            LabeledContent("Имя") {
                TextField(isAuthor ? "Амина" : "MIKAN STUDIO", text: $brandName)
                    .multilineTextAlignment(.trailing)
                    .focused($isBrandFocused)
                    .submitLabel(.done)
                    .onSubmit(commitBrandName)
            }
            .onChange(of: isBrandFocused) { _, focused in
                if !focused { commitBrandName() }
            }
            .onChange(of: brandName) { _, value in
                if value.count > Self.brandNameLimit { brandName = String(value.prefix(Self.brandNameLimit)) }
            }
        } header: {
            Text(isAuthor ? "Личный профиль автора" : "Профиль студии")
        } footer: {
            Text(profileFooter(settings))
        }
    }

    private func profileFooter(_ settings: SmmSettings) -> String {
        let name = "Имя маркетолог ставит в тексты и подписи."
        let off = settings.enabled ? "" : " Профиль выключен: маркетолог не готовит план и ничего не публикует."
        guard isAuthor else { return name + off }
        return "Личные соцсети \(brand) — отдельный контент со своими настройками, площадками, базой знаний и бюджетом. "
            + "Он не связан с рабочими процессами MIKAN: услуги, цены, мастера и записи студии сюда не попадают. "
            + name + off
    }

    private func platformsSection(_ payload: SmmSettingsPayload) -> some View {
        Section {
            NavigationLink(value: SmmRoute.accounts) {
                LabeledContent {
                    Text(accountsSummary(payload.accounts))
                } label: {
                    Label("Площадки", systemImage: "antenna.radiowaves.left.and.right")
                }
            }
            NavigationLink(value: SmmRoute.instagram) {
                Label("Instagram по API", systemImage: "camera")
            }
        } header: {
            Text("Площадки")
        } footer: {
            Text(isAuthor
                ? "Свой Telegram-канал и свой Instagram \(brand) — отдельно от площадок студии."
                : "Telegram-канал, Instagram и другие площадки студии.")
        }
    }

    private func accountsSummary(_ accounts: [SmmAccount]) -> String {
        let active = accounts.filter(\.isActive)
        guard !active.isEmpty else { return accounts.isEmpty ? "Не подключены" : "Выключены" }
        return active.map(\.platform.title).joined(separator: ", ")
    }

    private func voiceSection(_ settings: SmmSettings) -> some View {
        Section {
            ForEach(SmmSettingsTextField.allCases) { field in
                SmmSettingsTextRow(field: field, summary: field.summary(of: settings)) { editing = field }
            }
            NavigationLink(value: SmmRoute.memory) {
                Label("Память маркетолога", systemImage: "brain")
            }
        } header: {
            Text("Голос бренда")
        } footer: {
            Text("Маркетолог пишет в этом стиле. Правила, которые он вынес из замечаний, — в «Памяти маркетолога».")
        }
    }

    private func cadenceSection(_ settings: SmmSettings) -> some View {
        Section {
            cadenceStepper("Посты в Telegram", \.telegram, in: 0...21)
            cadenceStepper("Посты в Instagram", \.instagram, in: 0...21)
            cadenceStepper("Рилс", \.reels, in: 0...14)
            cadenceStepper("Сторис", \.stories, in: 0...35)
        } header: {
            Text("Сколько в неделю")
        } footer: {
            Text("Рилс лучше всего приводят новых людей — их стоит держать от трёх в неделю.")
        }
    }

    private func cadenceStepper(_ title: String, _ keyPath: WritableKeyPath<SmmCadence, Int>, in range: ClosedRange<Int>) -> some View {
        let value = settings?.cadence[keyPath: keyPath] ?? 0
        return Stepper(value: cadenceBinding(keyPath), in: range) {
            LabeledContent(title, value: value == 0 ? "Не нужно" : "\(value)")
                .monospacedDigit()
        }
    }

    private func publishingSection(_ settings: SmmSettings) -> some View {
        Section {
            Toggle("Автопилот для Telegram", isOn: binding(\.autopilot, in: settings) { SmmSettingsPatch(autopilot: $0) })
            Picker("Готовить пост за", selection: binding(\.reviewLeadHours, in: settings) { SmmSettingsPatch(reviewLeadHours: $0) }) {
                ForEach(Self.options(Self.leadHours, including: settings.reviewLeadHours), id: \.self) { hours in
                    Text(Self.leadTitle(hours)).tag(hours)
                }
            }
            Picker("Время по умолчанию", selection: binding(\.postTime, in: settings) { SmmSettingsPatch(postTime: $0) }) {
                ForEach(WorkdayHours.timeOptions(in: 0...Self.lastPostMinute, including: settings.postTime), id: \.self) { time in
                    Text(time).tag(time)
                }
            }
            .monospacedDigit()
        } header: {
            Text("Публикация")
        } footer: {
            Text(settings.autopilot
                ? "Автопилот: посты в Telegram выходят без одобрения, превью приходит заранее — выход можно остановить. Время — по часовому поясу студии."
                : "Каждый пост ждёт одобрения — в приложении или кнопкой в Telegram. Время — по часовому поясу студии.")
        }
    }

    private func approversSection(_ settings: SmmSettings) -> some View {
        Section {
            NavigationLink {
                SmmApproversView(profile: profile, brand: brand, people: people.value ?? [], selection: approversBinding(settings))
            } label: {
                LabeledContent("Одобряют") {
                    Text(approversSummary(settings))
                        .foregroundStyle(isAuthor && settings.approverIds.isEmpty ? Color.orange : .secondary)
                }
            }
            .disabled(people.value == nil)
        } header: {
            Text("Одобрение")
        } footer: {
            Text(approversFooter(settings))
        }
    }

    private func approversSummary(_ settings: SmmSettings) -> String {
        guard !settings.approverIds.isEmpty else { return isAuthor ? "Никто — выберите себя" : "Все, кто связан с ботом" }
        let names = settings.approverIds.compactMap { id in people.value?.first { $0.id == id }?.name }
        guard !names.isEmpty else { return "\(settings.approverIds.count)" }
        return names.count > 2 ? "\(names[0]) и ещё \(names.count - 1)" : names.joined(separator: ", ")
    }

    private func approversFooter(_ settings: SmmSettings) -> String {
        if let failure = people.failure {
            return "Не загрузился список сотрудников: \(failure) Потяните экран вниз, чтобы повторить."
        }
        let chosen = people.value?.filter { settings.approverIds.contains($0.id) } ?? []
        if chosen.contains(where: { !$0.telegram }) {
            return "У кого-то из одобряющих не привязан Telegram — превью на одобрение ему не придут."
        }
        if isAuthor {
            return settings.approverIds.isEmpty
                ? "Выберите себя — \(brand): пока никто не выбран, превью на одобрение никому не приходят."
                : "Превью личных постов приходят только им."
        }
        return settings.approverIds.isEmpty
            ? "Превью с кнопками «Одобрить», «Поправить», «Не выкладывать» приходят всем сотрудникам, связанным с ботом."
            : "Превью с кнопками «Одобрить», «Поправить», «Не выкладывать» приходят только им."
    }

    private func publisherSection(_ settings: SmmSettings) -> some View {
        Section {
            Picker("Сотрудник", selection: publisherBinding(settings)) {
                Text("Первый из одобряющих").tag(Int?.none)
                ForEach(people.value ?? []) { person in
                    Text(person.name).tag(Int?.some(person.id))
                }
            }
        } header: {
            Text("Instagram и сторис выкладывает")
        } footer: {
            Text(publisherFooter(settings))
        }
    }

    private func publisherFooter(_ settings: SmmSettings) -> String {
        let publisher = settings.publisherId.flatMap { id in people.value?.first { $0.id == id } }
        if let publisher, !publisher.telegram {
            return "У сотрудника не привязан Telegram — маркетолог не сможет прислать ему файлы."
        }
        let duty = "Маркетолог пришлёт файлы и текст в Telegram в момент выхода, а рилс — задачу на съёмку заранее."
        return isAuthor ? "Обычно это сама \(brand). " + duty : duty
    }

    private var knowledgeSection: some View {
        Section {
            NavigationLink(value: SmmRoute.knowledge) {
                Label("База знаний", systemImage: "books.vertical")
            }
            NavigationLink(value: SmmRoute.library()) {
                Label("Фотоархив", systemImage: "photo.stack")
            }
        } header: {
            Text(isAuthor ? "\(brand) для маркетолога" : "Студия для маркетолога")
        } footer: {
            Text("Портрет, места съёмки, свои даты и справка о тату и пирсинге — маркетолог опирается на них в постах, картинках и видео.")
        }
    }

    private func budgetSection(_ settings: SmmSettings, payload: SmmSettingsPayload) -> some View {
        Section {
            Picker("Бюджет в месяц", selection: binding(\.monthlyBudget, in: settings) { SmmSettingsPatch(monthlyBudget: $0) }) {
                ForEach(Self.options(Self.budgets, including: settings.monthlyBudget), id: \.self) { budget in
                    Text(budget == 0 ? "Без ограничения" : Money.format(budget)).tag(budget)
                }
            }
            LabeledContent("Потрачено в этом месяце") {
                Text(Money.format(payload.spend.month))
                    .monospacedDigit()
                    .foregroundStyle(isOverBudget(payload.spend) ? Color.orange : .secondary)
            }
            LabeledContent("Баланс Polza") {
                Text(payload.balance.map { Money.format(Int($0.rounded(.down))) } ?? "—")
                    .monospacedDigit()
                    .foregroundStyle((payload.balance ?? .infinity) < Self.lowBalance ? Color.orange : .secondary)
            }
        } header: {
            Text("Нейросети")
        } footer: {
            Text(budgetFooter(payload))
        }
    }

    private func isOverBudget(_ spend: SmmSpend) -> Bool {
        spend.budget > 0 && spend.month >= spend.budget
    }

    private func budgetFooter(_ payload: SmmSettingsPayload) -> String {
        var parts: [String] = []
        if isOverBudget(payload.spend) {
            parts.append("Бюджет месяца исчерпан — новые картинки и видео маркетолог не делает до следующего месяца.")
        }
        if let models = payload.models {
            parts.append("Тексты — \(Self.short(models.text)), картинки — \(Self.short(models.image)), видео — \(Self.short(models.video)).")
        }
        parts.append(isAuthor
            ? "Бюджет и расходы у профиля свои; ключ Polza общий, он задан на сервере."
            : "Ключ Polza общий для обоих профилей, он задан на сервере.")
        return parts.joined(separator: " ")
    }

    // MARK: Editor

    private func editor(_ field: SmmSettingsTextField) -> some View {
        let profile = profile
        return SmmTextEditorSheet(
            title: field.title,
            text: settings.map(field.value(in:)) ?? "",
            hint: field.hint(for: profile, brand: brand),
            maxLength: field.maxLength
        ) { text in
            let payload = try await api.saveSmmSettings(profile, field.patch(text))
            applySaved(payload, profile: profile, keepsLocal: pendingSaves > 0 || isCadencePending)
            if pendingSaves > 0 || isCadencePending {
                self.settings = self.settings.map { current in
                    var next = current
                    Self.copy(field, from: payload.settings, to: &next)
                    return next
                }
            }
            savedCount += 1
        }
    }

    private static func copy(_ field: SmmSettingsTextField, from source: SmmSettings, to target: inout SmmSettings) {
        switch field {
        case .voice: target.voice = source.voice
        case .audience: target.audience = source.audience
        case .goals: target.goals = source.goals
        case .directions: target.directions = source.directions
        }
    }

    // MARK: Bindings

    private func binding<Value: Equatable>(
        _ keyPath: WritableKeyPath<SmmSettings, Value>,
        in current: SmmSettings,
        patch: @escaping (Value) -> SmmSettingsPatch
    ) -> Binding<Value> {
        Binding(
            get: { settings?[keyPath: keyPath] ?? current[keyPath: keyPath] },
            set: { value in
                guard settings?[keyPath: keyPath] != value else { return }
                change(patch: patch(value)) { $0[keyPath: keyPath] = value }
            }
        )
    }

    private func cadenceBinding(_ keyPath: WritableKeyPath<SmmCadence, Int>) -> Binding<Int> {
        Binding(
            get: { settings?.cadence[keyPath: keyPath] ?? 0 },
            set: { value in
                guard var next = settings, next.cadence[keyPath: keyPath] != value else { return }
                next.cadence[keyPath: keyPath] = value
                settings = next
                scheduleCadenceSave()
            }
        )
    }

    private func approversBinding(_ current: SmmSettings) -> Binding<[Int]> {
        Binding(
            get: { settings?.approverIds ?? current.approverIds },
            set: { ids in
                guard settings?.approverIds != ids else { return }
                change(patch: SmmSettingsPatch(approverIds: ids)) { $0.approverIds = ids }
            }
        )
    }

    private func publisherBinding(_ current: SmmSettings) -> Binding<Int?> {
        Binding(
            get: { settings?.publisherId ?? current.publisherId },
            set: { id in
                guard settings?.publisherId != id else { return }
                change(patch: SmmSettingsPatch(publisherId: Nullable(id))) { $0.publisherId = id }
            }
        )
    }

    // MARK: Saving

    private func commitBrandName() {
        guard let settings else { return }
        let name = brandName.trimmed
        guard !name.isEmpty else {
            brandName = settings.brandName
            return
        }
        guard name != settings.brandName else { return }
        brandName = name
        change(patch: SmmSettingsPatch(brandName: name)) { $0.brandName = name }
    }

    /// Shows the change at once and queues its save.
    private func change(patch: SmmSettingsPatch, _ edit: (inout SmmSettings) -> Void) {
        guard var next = settings else { return }
        edit(&next)
        settings = next
        send(patch)
    }

    private func scheduleCadenceSave() {
        cadenceSave?.cancel()
        isCadencePending = true
        cadenceSave = Task {
            try? await Task.sleep(for: Self.cadenceDebounce)
            guard !Task.isCancelled else { return }
            isCadencePending = false
            guard let cadence = settings?.cadence else { return }
            send(SmmSettingsPatch(cadence: SmmCadencePatch(
                telegram: cadence.telegram, instagram: cadence.instagram, stories: cadence.stories, reels: cadence.reels
            )))
        }
    }

    /// Saves run one after another, so an older answer never overwrites a newer change.
    private func send(_ patch: SmmSettingsPatch) {
        let previous = lastSave
        let profile = profile
        pendingSaves += 1
        lastSave = Task {
            await previous?.value
            await save(patch, profile: profile)
            pendingSaves -= 1
        }
    }

    private func save(_ patch: SmmSettingsPatch, profile: SmmProfile) async {
        do {
            let payload = try await api.saveSmmSettings(profile, patch)
            applySaved(payload, profile: profile, keepsLocal: pendingSaves > 1 || isCadencePending)
            savedCount += 1
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.userMessage
            guard pendingSaves <= 1, !isCadencePending, profile == self.profile else { return }
            settings = remote.value?.settings
            brandName = remote.value?.settings.brandName ?? brandName
        }
    }

    /// The server's settings become the screen's unless newer changes are still on their way.
    private func applySaved(_ payload: SmmSettingsPayload, profile: SmmProfile, keepsLocal: Bool) {
        store.apply(payload.settings, to: profile)
        guard profile == self.profile else { return }
        remote.set(payload)
        guard !keepsLocal else { return }
        settings = payload.settings
        if !isBrandFocused { brandName = payload.settings.brandName }
    }

    private func load() async {
        let profile = profile
        async let peopleLoad: Void = people.load { try await api.smmPeople(profile) }
        await remote.load { try await api.smmSettings(profile) }
        await peopleLoad
        guard let value = remote.value, pendingSaves == 0, !isCadencePending else { return }
        settings = value.settings
        if !isBrandFocused { brandName = value.settings.brandName }
        store.apply(value.settings, to: profile)
    }

    // MARK: Options

    /// The preset values plus the current one when it is not among them.
    private static func options(_ presets: [Int], including current: Int) -> [Int] {
        presets.contains(current) ? presets : (presets + [current]).sorted()
    }

    private static func leadTitle(_ hours: Int) -> String {
        hours >= 24 && hours % 24 == 0 ? "\(hours / 24) сут." : "\(hours) ч"
    }

    /// «anthropic/claude-sonnet-5.5» → «claude-sonnet-5.5».
    private static func short(_ model: String) -> String {
        model.split(separator: "/").last.map(String.init) ?? model
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        SmmSettingsView()
    }
    .environment(SmmProfileStore())
    .previewEnvironment()
}
#endif
