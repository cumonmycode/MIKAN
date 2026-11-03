import SwiftUI

/// Photo archive of the selected profile (Titan `library.tsx`): a public Google Drive folder by its link. The marketer
/// knows what is in every photo and searches here by the descriptions when it writes posts. A person finds photos here
/// too — by search or in an album; opened from a post (`postId`), a tapped photo goes into that post and the screen
/// returns to it.
struct SmmLibraryView: View {
    @Environment(APIClient.self) private var api
    @Environment(SmmProfileStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let postId: String?

    @State private var remote = Remote<SmmLibrary>()
    @State private var query = ""
    /// The submitted search and its result (`nil` while searching).
    @State private var search = ""
    @State private var found: [SmmLibraryPhoto]?
    @State private var asksLink = false
    @State private var link = ""
    @State private var confirmsDisconnect = false
    @State private var isWorking = false
    @State private var selected: SmmLibraryPhoto?
    @State private var addingId: String?
    @State private var errorMessage: String?
    @State private var savedCount = 0

    /// The server searches from two characters.
    private static let minimumSearch = 2
    private static let pollInterval: Duration = .seconds(3)
    private static let coverSize: CGFloat = 56

    init(postId: String? = nil) {
        self.postId = postId
    }

    private var profile: SmmProfile { store.profile }
    private var brand: String { store.title(of: profile) }
    private var isSyncing: Bool { remote.value?.state?.progress != nil }

    var body: some View {
        List {
            if let library = remote.value, library.connected {
                headerSection(library)
                if search.isEmpty {
                    albumsSection(library)
                } else {
                    resultsSection
                }
            }
        }
        .overlay {
            if let library = remote.value {
                if !library.connected { notConnected }
            } else {
                RemoteStateOverlay(remote: remote, retry: load)
            }
        }
        .auraBackground()
        .navigationTitle("Фотоархив")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Тату, прокол, украшение, студия…")
        .onSubmit(of: .search) { runSearch() }
        .onChange(of: query) { _, value in
            if value.trimmed.isEmpty { clearSearch() }
        }
        .toolbar {
            if remote.value?.connected == true {
                ToolbarItem(placement: .topBarTrailing) { menu }
            }
        }
        .refreshable { await load() }
        .task(id: profile) { await load() }
        .task(id: isSyncing) { await pollWhileSyncing() }
        .remoteErrorAlert(remote)
        .errorAlert($errorMessage, title: "Не получилось")
        .sensoryFeedback(.success, trigger: savedCount)
        .smmArchivePhotoDialog(photo: $selected, addingId: $addingId, postId: postId) { dismiss() }
        .alert("Папка Google Диска", isPresented: $asksLink) {
            TextField("Ссылка на папку", text: $link)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Отмена", role: .cancel) {}
            Button("Подключить", action: connect)
        } message: {
            Text("В Google Диске: «Поделиться» → «Все, у кого есть ссылка» → «Читатель», затем «Копировать ссылку» и вставьте её сюда.")
        }
        .confirmationDialog("Отключить архив?", isPresented: $confirmsDisconnect, titleVisibility: .visible) {
            Button("Отключить", role: .destructive, action: disconnect)
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Маркетолог перестанет брать фото из архива. Описания сохранятся — при новом подключении он сразу всё вспомнит.")
        }
    }

    // MARK: Sections

    private var notConnected: some View {
        ContentUnavailableView {
            Label("Фотоархив не подключён", systemImage: "photo.stack")
        } description: {
            Text(profile == .author
                ? "Папка Google Диска с фото \(brand): работы, эскизы, жизнь и вдохновение. Маркетолог не скачивает её целиком: знает, что на каждом фото, и берёт в пост только нужное — как есть, с правкой или как образец для новой картинки."
                : "Папка Google Диска с фото работ, эскизов, украшений, студии и фотосессий. Маркетолог не скачивает её целиком: знает, что на каждом фото, и берёт в пост только нужное — как есть, с правкой или как образец для новой картинки.")
        } actions: {
            Button("Подключить папку", action: askLink)
                .buttonStyle(.glassProminent)
                .disabled(isWorking)
        }
    }

    private func headerSection(_ library: SmmLibrary) -> some View {
        Section {
            HStack(spacing: 14) {
                Image(systemName: "photo.stack.fill")
                    .font(.title3)
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(Color.green, in: .rect(cornerRadius: 11))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(library.state?.title.nonEmpty ?? "Фотоархив")
                        .font(.headline)
                        .lineLimit(1)
                    Text(countsText(library.counts))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            .accessibilityElement(children: .combine)
            Text(note(library.state))
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let progress = library.state?.progress {
                SmmProgressBanner(progress: progress)
                    .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
            }
            if let error = library.state?.error.nonEmpty {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
    }

    private func countsText(_ counts: SmmLibraryCounts) -> String {
        "\(counts.albums) альбомов · \(SmmText.count(counts.files)) фото · описано \(SmmText.count(counts.described))"
    }

    private func note(_ state: SmmLibraryState?) -> String {
        if postId != nil {
            return "Найдите фото поиском или в альбоме и нажмите на него — оно встанет в публикацию, обрезанное под формат."
        }
        let synced = state?.syncedAt.map { " Архив обновлён \($0.formatted(.dateTime.day().month(.wide).locale(.app)))." } ?? ""
        return "Маркетолог сам ищет здесь фото по описаниям, когда пишет посты.\(synced) Новые фото он описывает сам раз в день."
    }

    private func albumsSection(_ library: SmmLibrary) -> some View {
        Section("Альбомы") {
            if library.albums.isEmpty {
                Text(isSyncing ? "Маркетолог читает архив…" : "Альбомов пока нет — обновите архив.")
                    .foregroundStyle(.secondary)
            }
            ForEach(library.albums) { album in
                NavigationLink {
                    SmmAlbumView(albumId: album.id, title: album.title.nonEmpty ?? "Альбом", postId: postId) {
                        // The photo went into the post: close the album and the archive together.
                        dismiss()
                    }
                } label: {
                    albumRow(album)
                }
            }
        }
    }

    private func albumRow(_ album: SmmAlbum) -> some View {
        HStack(spacing: 12) {
            SmmRemoteImage(path: album.cover, placeholderSymbol: "photo.on.rectangle")
                .frame(width: Self.coverSize, height: Self.coverSize)
                .clipShape(.rect(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 2) {
                Text(album.title.nonEmpty ?? "Без названия")
                    .font(.headline)
                    .lineLimit(1)
                Text(albumSubtitle(album))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let about = album.about.nonEmpty {
                    Text(about)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func albumSubtitle(_ album: SmmAlbum) -> String {
        let parent = album.path.components(separatedBy: " / ").dropLast().joined(separator: " / ")
        let kind: String? = switch album.kind {
        case "template": "шаблоны сторис"
        case "logo": "логотипы"
        case "brand": "фирменный стиль"
        default: nil
        }
        return [parent.nonEmpty, "\(SmmText.count(album.files)) фото", kind].compactMap(\.self).joined(separator: " · ")
    }

    @ViewBuilder
    private var resultsSection: some View {
        Section {
            if let found {
                if found.isEmpty {
                    Text("Ничего не нашлось — попробуйте другие слова.")
                        .foregroundStyle(.secondary)
                } else {
                    SmmPhotoGrid(photos: found, busyId: addingId) { selected = $0 }
                        .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity)
            }
        } header: {
            Text(found.map { "Нашлось: \($0.count)" } ?? "Ищу…")
        } footer: {
            if search.count < Self.minimumSearch {
                Text("Нужно хотя бы два символа.")
            }
        }
    }

    private var menu: some View {
        Menu {
            Button("Обновить архив", systemImage: "arrow.clockwise", action: sync)
                .disabled(isSyncing || isWorking)
            if let url = remote.value?.state.flatMap({ URL(string: $0.url) }) {
                Button("Открыть в Google Диске", systemImage: "safari") { openURL(url) }
            }
            Button("Другая папка", systemImage: "link", action: askLink)
            Button("Отключить", systemImage: "xmark.circle", role: .destructive) { confirmsDisconnect = true }
        } label: {
            Label("Ещё", systemImage: "ellipsis")
        }
    }

    // MARK: Actions

    private func askLink() {
        link = ""
        asksLink = true
    }

    private func runSearch() {
        let text = query.trimmed
        search = text
        guard text.count >= Self.minimumSearch else {
            found = []
            return
        }
        found = nil
        let profile = profile
        Task {
            do {
                let photos = try await api.searchSmmLibrary(profile, query: text)
                if search == text { found = photos }
            } catch is CancellationError {
                return
            } catch {
                if search == text { found = [] }
                errorMessage = error.userMessage
            }
        }
    }

    private func clearSearch() {
        search = ""
        found = nil
    }

    private func connect() {
        let value = link.trimmed
        guard !value.isEmpty else { return }
        perform { try await api.connectSmmLibrary($0, link: value) }
    }

    private func sync() {
        perform { try await api.syncSmmLibrary($0) }
    }

    private func disconnect() {
        perform { try await api.disconnectSmmLibrary($0) }
    }

    private func perform(_ operation: @escaping (SmmProfile) async throws -> SmmLibrary) {
        let profile = profile
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                let library = try await operation(profile)
                withAnimation { remote.set(library) }
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
        await remote.load { try await api.smmLibrary(profile) }
    }

    /// While the archive is being read, its bar and counts are refreshed every few seconds.
    private func pollWhileSyncing() async {
        guard isSyncing else { return }
        let profile = profile
        while !Task.isCancelled, isSyncing {
            try? await Task.sleep(for: Self.pollInterval)
            guard !Task.isCancelled else { return }
            if let library = try? await api.smmLibrary(profile) {
                remote.set(library)
            }
        }
    }
}

/// An album of the archive (Titan `album.tsx`): all its photos in a grid, shown page by page (an album may hold
/// over a thousand). Opened from a post, a tapped photo goes into it and `onAdded` returns to the post.
struct SmmAlbumView: View {
    @Environment(APIClient.self) private var api
    @Environment(SmmProfileStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let albumId: String
    let title: String
    let postId: String?
    /// After a photo went into the post; `nil` — just go back.
    let onAdded: (() -> Void)?

    @State private var remote = Remote<[SmmLibraryPhoto]>()
    @State private var shown = SmmAlbumView.pageSize
    @State private var selected: SmmLibraryPhoto?
    @State private var addingId: String?

    private static let pageSize = 60

    init(albumId: String, title: String, postId: String? = nil, onAdded: (() -> Void)? = nil) {
        self.albumId = albumId
        self.title = title
        self.postId = postId
        self.onAdded = onAdded
    }

    private var photos: [SmmLibraryPhoto] { remote.value ?? [] }

    var body: some View {
        ScrollView {
            if !photos.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Text(postId != nil
                        ? "Нажмите на фото — оно встанет в публикацию, обрезанное под формат."
                        : "\(SmmText.count(photos.count)) фото. Нажмите, чтобы увидеть, что маркетолог знает о фото.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    SmmPhotoGrid(photos: Array(photos.prefix(shown)), busyId: addingId) { selected = $0 }
                    if shown < photos.count {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .onAppear { shown += Self.pageSize }
                    }
                }
                .padding(16)
            }
        }
        .overlay {
            RemoteStateOverlay(remote: remote, retry: load) {
                ContentUnavailableView("В альбоме нет фото", systemImage: "photo.on.rectangle")
            }
        }
        .background { AuraBackground() }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: store.profile) { await load() }
        .remoteErrorAlert(remote)
        .smmArchivePhotoDialog(photo: $selected, addingId: $addingId, postId: postId) {
            if let onAdded {
                onAdded()
            } else {
                dismiss()
            }
        }
    }

    private func load() async {
        let profile = store.profile
        await remote.load { try await api.smmAlbumPhotos(profile, albumId: albumId) }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        SmmLibraryView()
    }
    .environment(SmmProfileStore())
    .previewEnvironment()
}
#endif
