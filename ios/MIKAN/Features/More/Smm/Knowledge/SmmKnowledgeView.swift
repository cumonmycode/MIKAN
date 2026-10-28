import SwiftUI

/// «База знаний» of the selected profile (Titan `knowledge.tsx`) — what the marketer knows and leans on in plans, texts,
/// pictures and videos: the portrait (your words plus what it collected), shooting places by photos, what has been in
/// the socials, holidays and own dates, the tattoo & piercing reference. The author's base is her own: nothing of the
/// studio gets into it. While the marketer studies something, the screen refreshes itself.
struct SmmKnowledgeView: View {
    @Environment(APIClient.self) private var api
    @Environment(SmmProfileStore.self) private var store
    @State private var remote = Remote<SmmKnowledge>()
    @State private var editsPortrait = false
    @State private var asksZone = false
    @State private var zoneTitle = ""
    @State private var renaming: SmmZone?
    @State private var renameTitle = ""
    @State private var pendingZoneDelete: SmmZone?
    @State private var pendingDateDelete: SmmOwnDateRef?
    @State private var addsDate = false
    @State private var isWorking = false
    @State private var hasAppeared = false
    @State private var errorMessage: String?
    @State private var savedCount = 0

    private static let pollInterval: Duration = .milliseconds(2500)
    private static let upcomingShown = 8
    private static let thumbSize: CGFloat = 56
    /// `server/src/routes/smm-knowledge.ts`: a place's title is 2–60 characters, the owner's words up to 8000.
    static let zoneTitleRange = 2...60
    private static let portraitLimit = 8000

    private var profile: SmmProfile { store.profile }
    private var isAuthor: Bool { profile == .author }
    private var brand: String { store.title(of: profile) }
    private var isStudying: Bool { remote.value?.isWorking == true }

    var body: some View {
        List {
            if let knowledge = remote.value {
                introSection(knowledge)
                portraitSection(knowledge.brand)
                placesSection(knowledge.zones)
                socialsSection(knowledge.socials)
                datesSection(knowledge.dates)
                if let craft = knowledge.craft {
                    craftSection(craft)
                }
                Section {
                    NavigationLink(value: SmmRoute.memory) {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Правила и выводы маркетолога")
                                Text("Что вы просили запомнить и что маркетолог понял из цифр")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: "brain.head.profile")
                        }
                    }
                }
            }
        }
        .overlay {
            if remote.value == nil { RemoteStateOverlay(remote: remote, retry: load) }
        }
        .auraBackground()
        .navigationTitle("База знаний")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: profile) { await load() }
        .task(id: isStudying) { await pollWhileStudying() }
        .onAppear {
            // Back from a place: its photos and texts may have changed there.
            if hasAppeared { Task { await reloadQuietly() } }
            hasAppeared = true
        }
        .remoteErrorAlert(remote)
        .errorAlert($errorMessage, title: "Не получилось")
        .sensoryFeedback(.success, trigger: savedCount)
        .sheet(isPresented: $editsPortrait) { portraitEditor }
        .sheet(isPresented: $addsDate) {
            SmmOwnDateSheet(profile: profile, brand: brand) { knowledge in
                remote.set(knowledge)
                savedCount += 1
            }
        }
        .alert("Новое место съёмки", isPresented: $asksZone) {
            TextField("Название", text: $zoneTitle)
            Button("Отмена", role: .cancel) {}
            Button("Добавить", action: addZone)
        } message: {
            Text(isAuthor ? "Например, «Мастерская» или «Балкон»." : "Например, «Кабинет пирсинга» или «Витрина с украшениями».")
        }
        .alert(
            "Название места",
            isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }),
            presenting: renaming
        ) { zone in
            TextField("Название", text: $renameTitle)
            Button("Отмена", role: .cancel) {}
            Button("Сохранить") { rename(zone) }
        }
        .confirmationDialog(
            "Удалить место съёмки?",
            isPresented: Binding(get: { pendingZoneDelete != nil }, set: { if !$0 { pendingZoneDelete = nil } }),
            titleVisibility: .visible,
            presenting: pendingZoneDelete
        ) { zone in
            Button("Удалить «\(zone.title)»", role: .destructive) { deleteZone(zone) }
            Button("Отмена", role: .cancel) {}
        } message: { _ in
            Text("Фото и описание места уйдут из базы знаний.")
        }
        .confirmationDialog(
            "Убрать дату?",
            isPresented: Binding(get: { pendingDateDelete != nil }, set: { if !$0 { pendingDateDelete = nil } }),
            titleVisibility: .visible,
            presenting: pendingDateDelete
        ) { date in
            Button("Убрать «\(date.title)»", role: .destructive) { deleteDate(date) }
            Button("Отмена", role: .cancel) {}
        }
    }

    // MARK: Intro and portrait

    private func introSection(_ knowledge: SmmKnowledge) -> some View {
        let photos = knowledge.zones.reduce(0) { $0 + $1.photos.count }
        let posts = (knowledge.socials.posts ?? [:]).values.reduce(0, +)
        let separate = isAuthor ? " Это отдельная база \(brand): данные студии сюда не попадают." : ""
        return Section {
            HStack(spacing: 14) {
                Image(systemName: "books.vertical.fill")
                    .font(.title3)
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(Color.accentColor, in: .rect(cornerRadius: 13))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(isAuthor ? "Что маркетолог знает о \(brand)" : "Что маркетолог знает о студии")
                        .font(.headline)
                    Text("Прочитал \(SmmText.count(posts)) постов · \(photos) фото мест съёмки · справка о тату и пирсинге. "
                        + "На этом он строит планы, тексты, картинки и видео.\(separate)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    private func portraitSection(_ doc: SmmKnowledgeDoc) -> some View {
        Section(isAuthor ? "Портрет: \(brand)" : "Портрет студии") {
            if doc.progress != nil || doc.error != nil {
                SmmKnowledgeDocState(progress: doc.progress, error: doc.error)
            }
            if let owner = doc.ownerText.nonEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    SmmKnowledgeCaption(text: "Вашими словами — главное для маркетолога")
                    SmmKnowledgeExpandableText(text: owner, lines: 4)
                }
            }
            if let collected = doc.aiText.nonEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    SmmKnowledgeCaption(text: collectedCaption(doc.aiAt))
                    SmmKnowledgeExpandableText(text: collected)
                }
            } else {
                Text(isAuthor
                    ? "Маркетолог соберёт портрет \(brand) из её слов и её соцсетей — кто она, о чём пишет, что вдохновляет. Данные студии сюда не попадают."
                    : "Маркетолог соберёт портрет студии из её данных в MIKAN (услуги, цены, мастера, украшения), соцсетей и ваших слов — кто вы, стили, мастера и традиции.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Button(doc.ownerText.isEmpty ? (isAuthor ? "Рассказать о себе" : "Рассказать о студии") : "Изменить свои слова", systemImage: "pencil") {
                editsPortrait = true
            }
            Button(doc.aiText.isEmpty ? "Собрать" : "Обновить", systemImage: "arrow.clockwise") { refresh(.brand) }
                .disabled(doc.progress != nil || isWorking)
        }
    }

    private func collectedCaption(_ date: Date?) -> String {
        let source = isAuthor ? "Маркетолог собрал из ваших слов и соцсетей" : "Маркетолог собрал из данных студии и соцсетей"
        guard let date else { return source }
        return "\(source) · \(date.formatted(.dateTime.day().month(.wide).locale(.app)))"
    }

    private var portraitEditor: some View {
        let profile = profile
        return SmmTextEditorSheet(
            title: isAuthor ? "О себе — для маркетолога" : "О студии — для маркетолога",
            text: remote.value?.brand.ownerText ?? "",
            hint: isAuthor
                ? "Что маркетологу важно знать о вас своими словами: кто вы, чем занимаетесь, стиль, о чём хотите и не хотите писать, важные люди и события. Это главнее всего, что маркетолог соберёт сам. Этот профиль не связан со студией."
                : "Что маркетологу важно знать о студии своими словами: история и чем гордимся, стили и специализация мастеров, правила (стерильность, возраст, предоплата), лица студии, традиции, о чём не писать. Это главнее всего, что маркетолог соберёт сам.",
            maxLength: Self.portraitLimit
        ) { text in
            let knowledge = try await api.saveSmmBrandText(profile, ownerText: text)
            remote.set(knowledge)
            savedCount += 1
        }
    }

    // MARK: Places

    private func placesSection(_ zones: [SmmZone]) -> some View {
        Section {
            ForEach(zones) { zone in
                NavigationLink(value: SmmRoute.zone(id: zone.id)) {
                    zoneRow(zone)
                }
                .swipeActions(edge: .trailing) {
                    Button("Удалить", systemImage: "trash") { pendingZoneDelete = zone }
                        .tint(.red)
                    Button("Переименовать", systemImage: "pencil") { startRename(zone) }
                        .tint(.indigo)
                }
                .contextMenu {
                    Button("Переименовать", systemImage: "pencil") { startRename(zone) }
                    Button("Удалить", systemImage: "trash", role: .destructive) { pendingZoneDelete = zone }
                }
            }
            Button("Добавить место", systemImage: "plus") {
                zoneTitle = ""
                asksZone = true
            }
            .disabled(isWorking)
        } header: {
            Text("Места съёмки")
        } footer: {
            Text(isAuthor
                ? "Места, где снимает \(brand): дом, мастерская, любимые места в городе. По фото с разных ракурсов маркетолог рисует картинки и видео именно там."
                : "Фото каждого места студии с разных ракурсов — кабинеты, зона ожидания, витрина с украшениями. Когда сюжет у вас в студии, маркетолог рисует картинку и видео именно в этом месте.")
        }
    }

    private func zoneRow(_ zone: SmmZone) -> some View {
        HStack(spacing: 12) {
            SmmRemoteImage(path: zone.photos.first?.url, placeholderSymbol: "camera")
                .frame(width: Self.thumbSize, height: Self.thumbSize)
                .clipShape(.rect(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 2) {
                Text(zone.title)
                    .font(.headline)
                    .lineLimit(1)
                Text(zoneSubtitle(zone))
                    .font(.caption)
                    .foregroundStyle(zone.photos.isEmpty && zone.progress == nil ? Color.orange : .secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if zone.progress != nil {
                ProgressView()
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func zoneSubtitle(_ zone: SmmZone) -> String {
        if zone.progress != nil { return "Маркетолог смотрит фото…" }
        let photos = zone.photos.isEmpty ? "Нет фото" : "\(zone.photos.count) фото"
        let described: String? = zone.aiText.isEmpty ? (zone.ownerText.isEmpty ? nil : "есть описание") : "описано маркетологом"
        return [photos, described].compactMap(\.self).joined(separator: " · ")
    }

    // MARK: Socials

    private func socialsSection(_ doc: SmmKnowledgeDoc) -> some View {
        Section("Что было в соцсетях") {
            if doc.progress != nil || doc.error != nil {
                SmmKnowledgeDocState(progress: doc.progress, error: doc.error)
            }
            Text(socialsCounts(doc))
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let text = doc.aiText.nonEmpty {
                SmmKnowledgeExpandableText(text: text)
            } else {
                Text("Как вы пишете, какие рубрики и традиции, что заходило и что нет — чтобы продолжать в том же духе и не повторяться.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Button(doc.aiText.isEmpty ? "Изучить соцсети" : "Изучить заново", systemImage: "sparkles") { refresh(.socials) }
                .disabled(doc.progress != nil || isWorking)
        }
    }

    private func socialsCounts(_ doc: SmmKnowledgeDoc) -> String {
        let posts = doc.posts ?? [:]
        let counts = [("telegram", "Telegram"), ("instagram", "Instagram")].compactMap { key, title -> String? in
            guard let count = posts[key], count > 0 else { return nil }
            return "\(title) — \(SmmText.count(count))"
        }
        guard !counts.isEmpty else { return "Маркетолог прочитает всю ленту канала и Instagram." }
        let studied = doc.aiAt.map { " Разбор от \($0.formatted(.dateTime.day().month(.wide).locale(.app)))." } ?? ""
        return "Прочитано постов: \(counts.joined(separator: ", ")).\(studied)"
    }

    // MARK: Dates

    private func datesSection(_ dates: SmmKnowledgeDates) -> some View {
        let days = Array(dates.upcoming.filter { $0.until == nil }.prefix(Self.upcomingShown))
        let seasons = dates.upcoming.filter { $0.until != nil }
        let ownAhead = Set(days.compactMap { $0.own == true ? $0.ownId : nil })
        let ownRest = dates.own.filter { !ownAhead.contains($0.id) }
        return Group {
            Section {
                ForEach(days) { date in
                    SmmKnowledgeDateRow(date: date)
                        .swipeActions(edge: .trailing) {
                            if date.own == true, let id = date.ownId {
                                Button("Убрать", systemImage: "trash") { pendingDateDelete = SmmOwnDateRef(id: id, title: date.title) }
                                    .tint(.red)
                            }
                        }
                }
                if !seasons.isEmpty {
                    Text("Сейчас и скоро: \(seasons.map { $0.title.lowercased() }.joined(separator: ", ")).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if days.isEmpty, seasons.isEmpty {
                    Text("В ближайшие три месяца поводов нет.")
                        .foregroundStyle(.secondary)
                }
                Button("Своя дата", systemImage: "calendar.badge.plus") { addsDate = true }
            } header: {
                Text("Праздники и даты")
            } footer: {
                Text("На важные даты маркетолог сам ставит тематические посты, под продающие поводы готовит анонсы заранее, в траурные дни молчит.")
            }
            if !ownRest.isEmpty {
                Section(isAuthor ? "Свои даты \(brand)" : "Свои даты студии") {
                    ForEach(ownRest) { date in
                        LabeledContent(date.title, value: SmmText.dayTitle(date.day))
                            .swipeActions(edge: .trailing) {
                                Button("Убрать", systemImage: "trash") { pendingDateDelete = SmmOwnDateRef(id: date.id, title: date.title) }
                                    .tint(.red)
                            }
                            .contextMenu {
                                Button("Убрать", systemImage: "trash", role: .destructive) {
                                    pendingDateDelete = SmmOwnDateRef(id: date.id, title: date.title)
                                }
                            }
                    }
                }
            }
        }
    }

    // MARK: Craft

    private func craftSection(_ craft: SmmCraft) -> some View {
        Section {
            ForEach(craft.sections) { section in
                SmmCraftSectionRow(section: section)
            }
        } header: {
            Text("Тату и пирсинг: что знает маркетолог")
        } footer: {
            Text("Источник: \(craft.source). "
                + (isAuthor ? "Своё — как вы работаете и во что верите — расскажите в «Портрете»." : "Правила вашей студии расскажите в «Портрете студии»."))
        }
    }

    // MARK: Actions

    private func refresh(_ key: SmmKnowledgeKey) {
        perform { try await api.refreshSmmKnowledge($0, key: key) }
    }

    private func addZone() {
        let title = zoneTitle.trimmed
        guard Self.zoneTitleRange.contains(title.count) else {
            errorMessage = "Название — от 2 до 60 символов."
            return
        }
        perform { try await api.addSmmZone($0, title: title) }
    }

    private func startRename(_ zone: SmmZone) {
        renameTitle = zone.title
        renaming = zone
    }

    private func rename(_ zone: SmmZone) {
        let title = renameTitle.trimmed
        guard title != zone.title else { return }
        guard Self.zoneTitleRange.contains(title.count) else {
            errorMessage = "Название — от 2 до 60 символов."
            return
        }
        perform { try await api.updateSmmZone($0, id: zone.id, SmmZoneBody(title: title)) }
    }

    private func deleteZone(_ zone: SmmZone) {
        perform { try await api.deleteSmmZone($0, id: zone.id) }
    }

    private func deleteDate(_ date: SmmOwnDateRef) {
        perform { try await api.deleteSmmDate($0, id: date.id) }
    }

    private func perform(_ operation: @escaping (SmmProfile) async throws -> SmmKnowledge) {
        let profile = profile
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                let knowledge = try await operation(profile)
                withAnimation { remote.set(knowledge) }
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
        await remote.load { try await api.smmKnowledge(profile) }
    }

    private func reloadQuietly() async {
        if let knowledge = try? await api.smmKnowledge(profile) {
            remote.set(knowledge)
        }
    }

    private func pollWhileStudying() async {
        while !Task.isCancelled, isStudying {
            try? await Task.sleep(for: Self.pollInterval)
            guard !Task.isCancelled else { return }
            await reloadQuietly()
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        SmmKnowledgeView()
    }
    .environment(SmmProfileStore())
    .previewEnvironment()
}
#endif
