import PhotosUI
import SwiftUI

/// A shooting place of the profile (Titan `zone.tsx`): photos from different angles, your description and what the
/// marketer saw in the photos. By them the marketer draws pictures and videos in this very place when a post's scene
/// is there. Rename and delete from the menu.
struct SmmZoneView: View {
    @Environment(APIClient.self) private var api
    @Environment(SmmProfileStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let zoneId: String

    @State private var remote = Remote<SmmKnowledge>()
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var upload: UploadProgress?
    @State private var pendingPhotoDelete: SmmZonePhoto?
    @State private var editsDescription = false
    @State private var renaming = false
    @State private var renameTitle = ""
    @State private var confirmsDelete = false
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var savedCount = 0

    private struct UploadProgress: Equatable {
        let done: Int
        let total: Int
    }

    /// Titan picks up to 10 photos at a time.
    private static let maxPick = 10
    private static let pollInterval: Duration = .milliseconds(2500)
    /// `server/src/routes/smm-knowledge.ts`: the owner's description is up to 3000 characters.
    private static let descriptionLimit = 3000

    private var profile: SmmProfile { store.profile }
    private var isAuthor: Bool { profile == .author }
    private var zone: SmmZone? { remote.value?.zones.first { $0.id == zoneId } }
    private var isDescribing: Bool { zone?.progress != nil }

    var body: some View {
        List {
            if let zone {
                photosSection(zone)
                ownerSection(zone)
                marketerSection(zone)
            }
        }
        .overlay {
            if remote.value == nil {
                RemoteStateOverlay(remote: remote, retry: load)
            } else if zone == nil {
                ContentUnavailableView("Место не найдено", systemImage: "mappin.slash", description: Text("Его уже удалили."))
            }
        }
        .auraBackground()
        .navigationTitle(zone?.title ?? "Место съёмки")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let zone {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Переименовать", systemImage: "pencil") {
                            renameTitle = zone.title
                            renaming = true
                        }
                        Button("Удалить место", systemImage: "trash", role: .destructive) { confirmsDelete = true }
                    } label: {
                        Label("Ещё", systemImage: "ellipsis")
                    }
                    .disabled(isWorking)
                }
            }
        }
        .refreshable { await load() }
        .task(id: profile) { await load() }
        .task(id: isDescribing) { await pollWhileDescribing() }
        .remoteErrorAlert(remote)
        .errorAlert($errorMessage, title: "Не получилось")
        .sensoryFeedback(.success, trigger: savedCount)
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await uploadPhotos(items) }
        }
        .sheet(isPresented: $editsDescription) { descriptionEditor }
        .alert("Название места", isPresented: $renaming) {
            TextField("Название", text: $renameTitle)
            Button("Отмена", role: .cancel) {}
            Button("Сохранить", action: rename)
        }
        .confirmationDialog(
            "Убрать фото?",
            isPresented: Binding(get: { pendingPhotoDelete != nil }, set: { if !$0 { pendingPhotoDelete = nil } }),
            titleVisibility: .visible,
            presenting: pendingPhotoDelete
        ) { photo in
            Button("Убрать", role: .destructive) { deletePhoto(photo) }
            Button("Отмена", role: .cancel) {}
        } message: { _ in
            Text("Маркетолог перестанет опираться на этот ракурс.")
        }
        .confirmationDialog("Удалить «\(zone?.title ?? "место")»?", isPresented: $confirmsDelete, titleVisibility: .visible) {
            Button("Удалить", role: .destructive, action: deleteZone)
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Фото и описание места уйдут из базы знаний.")
        }
    }

    // MARK: Sections

    private func photosSection(_ zone: SmmZone) -> some View {
        Section {
            if !zone.photos.isEmpty {
                SmmPhotoGrid(zonePhotos: zone.photos) { pendingPhotoDelete = $0 }
                    .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
            }
            // The picker label closure is Sendable, so its title is computed outside it.
            let title = upload.map { "Загружаем \(min($0.done + 1, $0.total)) из \($0.total)…" } ?? "Добавить фото"
            let isUploading = upload != nil
            PhotosPicker(
                selection: $pickerItems,
                maxSelectionCount: Self.maxPick,
                selectionBehavior: .ordered,
                matching: .images,
                photoLibrary: .shared()
            ) {
                HStack {
                    Label(title, systemImage: "photo.badge.plus")
                    if isUploading {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(upload != nil || isWorking)
        } header: {
            Text(zone.photos.isEmpty ? "Фото" : "Фото · \(zone.photos.count)")
        } footer: {
            Text("Снимите место с 3–6 ракурсов: общий план от входа, с противоположной стороны, крупно — "
                + (isAuthor ? "стол, свет, детали." : "кресло, витрина, декор.")
                + " При обычном своём свете, без людей в кадре. Нажмите на фото, чтобы убрать его.")
        }
    }

    private func ownerSection(_ zone: SmmZone) -> some View {
        Section("Ваше описание") {
            if let text = zone.ownerText.nonEmpty {
                Text(text)
                    .font(.subheadline)
                    .textSelection(.enabled)
            } else {
                Text("Для чего место, что в нём стоит, какой свет — маркетолог допишет остальное по фото.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Button(zone.ownerText.isEmpty ? "Описать" : "Изменить", systemImage: "pencil") { editsDescription = true }
        }
    }

    private func marketerSection(_ zone: SmmZone) -> some View {
        let canDescribe = !zone.photos.isEmpty || !zone.ownerText.trimmed.isEmpty
        return Section {
            if zone.progress != nil || zone.error != nil {
                SmmKnowledgeDocState(progress: zone.progress, error: zone.error)
            }
            if let text = zone.aiText.nonEmpty {
                Text(text)
                    .font(.subheadline)
                    .textSelection(.enabled)
            } else {
                Text("Маркетолог посмотрит фото и опишет место — планировку, свет, цвета, мебель и удачные ракурсы. "
                    + "По этому описанию сцены здесь получаются похожими на настоящие.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Button(zone.aiText.isEmpty ? "Маркетолог, опиши место" : "Описать заново", systemImage: "sparkles", action: describe)
                .disabled(!canDescribe || zone.progress != nil || isWorking)
        } header: {
            Text("Что видит маркетолог")
        } footer: {
            if !canDescribe {
                Text("Сначала добавьте фото или своё описание.")
            }
        }
    }

    private var descriptionEditor: some View {
        let profile = profile
        let zoneId = zoneId
        return SmmTextEditorSheet(
            title: zone?.title ?? "Место съёмки",
            text: zone?.ownerText ?? "",
            hint: isAuthor
                ? "Как выглядит место и что вы там делаете: что стоит, какой свет, настроение. Маркетолог дополнит по фото."
                : "Как выглядит место и для чего оно: что стоит, какой свет, что в нём происходит (сеансы тату, проколы, примерка украшений). Маркетолог дополнит по фото.",
            maxLength: Self.descriptionLimit
        ) { text in
            let knowledge = try await api.updateSmmZone(profile, id: zoneId, SmmZoneBody(ownerText: text))
            remote.set(knowledge)
            savedCount += 1
        }
    }

    // MARK: Actions

    /// One photo per request, the screen updates after each; the ones that made it stay when some fail.
    private func uploadPhotos(_ items: [PhotosPickerItem]) async {
        let batch = Array(items.prefix(Self.maxPick))
        pickerItems = []
        guard !batch.isEmpty else { return }
        let profile = profile
        upload = UploadProgress(done: 0, total: batch.count)
        defer { upload = nil }
        var failures = 0
        var lastError: String?
        for (index, item) in batch.enumerated() {
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else {
                    throw ImagePreparerError.unreadable
                }
                let jpeg = try await SmmZonePhotoPreparer.jpeg(from: data)
                remote.set(try await api.uploadSmmZonePhoto(profile, zoneId: zoneId, jpegData: jpeg))
            } catch is CancellationError {
                return
            } catch {
                failures += 1
                lastError = error.userMessage
            }
            upload = UploadProgress(done: index + 1, total: batch.count)
        }
        if failures > 0 {
            let reason = lastError ?? "Попробуйте ещё раз."
            errorMessage = batch.count > 1 ? "Не загрузилось \(failures) из \(batch.count) фото. \(reason)" : reason
        } else {
            savedCount += 1
        }
    }

    private func deletePhoto(_ photo: SmmZonePhoto) {
        perform { try await api.deleteSmmZonePhoto($0, zoneId: zoneId, photoId: photo.id) }
    }

    private func describe() {
        perform { try await api.describeSmmZone($0, zoneId: zoneId) }
    }

    private func rename() {
        let title = renameTitle.trimmed
        guard title != zone?.title else { return }
        guard SmmKnowledgeView.zoneTitleRange.contains(title.count) else {
            errorMessage = "Название — от 2 до 60 символов."
            return
        }
        perform { try await api.updateSmmZone($0, id: zoneId, SmmZoneBody(title: title)) }
    }

    /// Goes back to the knowledge base, which rereads itself on return.
    private func deleteZone() {
        let profile = profile
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                _ = try await api.deleteSmmZone(profile, id: zoneId)
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
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

    private func pollWhileDescribing() async {
        let profile = profile
        while !Task.isCancelled, isDescribing {
            try? await Task.sleep(for: Self.pollInterval)
            guard !Task.isCancelled else { return }
            if let knowledge = try? await api.smmKnowledge(profile) {
                remote.set(knowledge)
            }
        }
    }
}

/// Zone photos go up at 2048 px on the long side (the server's limit for places), off the main actor.
nonisolated enum SmmZonePhotoPreparer {
    static let maxPixelSize = 2048

    @concurrent
    static func jpeg(from data: Data) async throws -> Data {
        try ImagePreparer.jpeg(from: data, maxPixelSize: maxPixelSize)
    }
}
