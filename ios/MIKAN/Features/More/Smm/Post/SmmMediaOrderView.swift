import SwiftUI

/// Order of carousel slides and story frames (Titan `order.tsx`): drag the rows — the marketer posts them in this
/// order or hands them over so; the first is what the feed shows.
struct SmmMediaOrderView: View {
    @Environment(APIClient.self) private var api
    @Environment(SmmProfileStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let postId: String

    @State private var post = Remote<SmmPost>()
    @State private var initial: [SmmMedia] = []
    @State private var order: [SmmMedia] = []
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var savedCount = 0

    private var isChanged: Bool { order.map(\.id) != initial.map(\.id) }
    private var isStory: Bool { post.value?.format == .story }
    private var noun: String { isStory ? "Кадр" : "Слайд" }

    var body: some View {
        List {
            if post.value != nil {
                Section {
                    ForEach(Array(order.enumerated()), id: \.element.id) { index, media in
                        row(media, index: index)
                    }
                    .onMove { offsets, destination in
                        order.move(fromOffsets: offsets, toOffset: destination)
                    }
                } footer: {
                    Text(hint)
                }
            }
        }
        .environment(\.editMode, .constant(.active))
        .overlay {
            RemoteStateOverlay(remote: post, isEmpty: { _ in order.isEmpty }, retry: load) {
                ContentUnavailableView("Нечего упорядочить", systemImage: "square.stack", description: Text("В публикации нет готовых картинок и видео."))
            }
        }
        .auraBackground()
        .navigationTitle("Порядок")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(isSaving)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if isSaving {
                    ProgressView()
                } else {
                    Button("Сохранить", action: save)
                        .disabled(!isChanged)
                }
            }
        }
        .task { if post.value == nil { await load() } }
        .sensoryFeedback(.success, trigger: savedCount)
        .errorAlert($errorMessage, title: "Порядок не сохранился")
    }

    private var hint: String {
        let goes = isStory ? "Кадры выйдут" : "Слайды пойдут"
        return "Перетащите \(noun.lowercased()) за ручку справа. \(goes) в этом порядке; первый — то, что увидят в ленте."
    }

    private func row(_ media: SmmMedia, index: Int) -> some View {
        HStack(spacing: 14) {
            SmmRemoteImage(path: media.isVideo ? nil : media.url, placeholderSymbol: media.isVideo ? "play.fill" : "photo")
                .frame(width: 56, height: 70)
                .clipShape(.rect(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 2) {
                Text("\(noun) \(index + 1)")
                    .font(.headline)
                Text(Self.source(media))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Выше") { move(media, by: -1) }
        .accessibilityAction(named: "Ниже") { move(media, by: 1) }
    }

    private static func source(_ media: SmmMedia) -> String {
        if media.isVideo { return "Видео" }
        switch media.source {
        case .archive: return "Фото из архива"
        case .upload: return "Своё фото"
        default: return "Картинка маркетолога"
        }
    }

    private func move(_ media: SmmMedia, by delta: Int) {
        guard let from = order.firstIndex(where: { $0.id == media.id }) else { return }
        let to = from + delta
        guard order.indices.contains(to) else { return }
        var next = order
        next.swapAt(from, to)
        order = next
    }

    private func load() async {
        await post.load { try await api.smmPost(store.profile, id: postId).post }
        let ready = post.value?.selectedMedia.filter { $0.status == .done } ?? []
        initial = ready
        order = ready
    }

    private func save() {
        let sorts = order.map(\.sort)
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                _ = try await api.reorderSmmMedia(store.profile, postId: postId, sorts: sorts)
                savedCount += 1
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}
