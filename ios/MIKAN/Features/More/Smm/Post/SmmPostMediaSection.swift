import AVKit
import PhotosUI
import SwiftUI

/// Pictures and videos as they go out (feed 4:5, stories and reels 9:16), swiped page by page; every position has
/// its variants and actions: a new variant, own description, from the archive, own photo or video, an AI video,
/// the order, saving and removal (Titan `MediaBlock`).
struct SmmPostMediaSection: View {
    @Environment(APIClient.self) private var api
    let model: SmmPostModel
    let post: SmmPost

    @State private var pageId: String?
    @State private var pickerItem: PhotosPickerItem?
    @State private var describes = false
    @State private var imagePrompt = ""
    @State private var asksVideo = false
    @State private var videoWish = ""
    @State private var confirmsRemove = false

    private static let maxMediaHeight: CGFloat = 520

    private var media: [SmmMedia] { post.selectedMedia }
    private var isVertical: Bool { post.format == .story || post.format == .reel }
    /// Width over height of a frame.
    private var aspect: CGFloat { isVertical ? 9 / 16 : 4 / 5 }
    private var isEditable: Bool { post.status != .published }
    private var isActing: Bool { model.acting != nil }
    private var hasPendingVideo: Bool { post.media.contains { $0.isVideo && $0.isPending } }

    private var current: SmmMedia? {
        media.first { $0.id == pageId } ?? media.first
    }

    private var currentIndex: Int {
        guard let current else { return 0 }
        return media.firstIndex { $0.id == current.id } ?? 0
    }

    /// Ready picture variants of the current position.
    private var variants: [SmmMedia] {
        guard let current, current.kind == .image else { return [] }
        return post.media.filter { $0.kind == .image && $0.sort == current.sort && $0.status == .done && $0.url != nil }
    }

    var body: some View {
        Section {
            VStack(spacing: 10) {
                if media.isEmpty {
                    emptyFrame
                } else {
                    pager
                    if media.count > 1 { dots }
                }
                if variants.count > 1 { variantStrip }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            // Watchers and prompts hang on one row: modifiers on a `Section` reach every row.
            prompts(actions)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 4, trailing: 0))
        }
        .listSectionSeparator(.hidden)
    }

    private func prompts(_ content: some View) -> some View {
        content
            .onChange(of: pickerItem) { _, item in
                guard let item else { return }
                pickerItem = nil
                Task { await model.upload(item, api: api) }
            }
            .onChange(of: media.map(\.id)) { _, ids in
                if let pageId, !ids.contains(pageId) { self.pageId = ids.first }
            }
            .alert("Какую картинку нарисовать?", isPresented: $describes) {
                TextField("Сцена своими словами", text: $imagePrompt, axis: .vertical)
                Button("Нарисовать") { drawDescribed() }
                Button("Отмена", role: .cancel) {}
            } message: {
                Text("Опишите сцену своими словами — маркетолог нарисует новый вариант.")
            }
            .alert("Видео нейросетью", isPresented: $asksVideo) {
                TextField("Что должно быть в ролике (необязательно)", text: $videoWish, axis: .vertical)
                Button("Сделать") { startVideo() }
                Button("Отмена", role: .cancel) {}
            } message: {
                Text(Self.videoMessage(profile: model.profile))
            }
            .confirmationDialog(removeTitle, isPresented: $confirmsRemove, titleVisibility: .visible) {
                Button("Убрать", role: .destructive) { removeCurrent() }
                Button("Отмена", role: .cancel) {}
            } message: {
                Text("Файл и его варианты уйдут из публикации.")
            }
    }

    // MARK: Frames

    private var pager: some View {
        TabView(selection: Binding(get: { current?.id }, set: { pageId = $0 })) {
            ForEach(media) { item in
                SmmMediaFrame(media: item)
                    .tag(Optional(item.id))
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .aspectRatio(aspect, contentMode: .fit)
        .frame(maxHeight: Self.maxMediaHeight)
        .clipShape(.rect(cornerRadius: 20))
        .frame(maxWidth: .infinity)
    }

    private var emptyFrame: some View {
        VStack(spacing: 10) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.system(size: 36))
                .foregroundStyle(.tertiary)
            Text(post.status == .idea ? "Картинку маркетолог нарисует вместе с текстом" : "Визуала пока нет")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: 200)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 20))
    }

    private var dots: some View {
        HStack(spacing: 6) {
            ForEach(Array(media.enumerated()), id: \.element.id) { index, item in
                Capsule()
                    .fill(index == currentIndex ? Color.accentColor : Color(.tertiaryLabel))
                    .frame(width: index == currentIndex ? 18 : 6, height: 6)
                    .accessibilityHidden(true)
                    .id(item.id)
            }
        }
        .animation(.snappy, value: currentIndex)
        .accessibilityElement()
        .accessibilityLabel("\(post.format == .story ? "Кадр" : "Слайд") \(currentIndex + 1) из \(media.count)")
    }

    private var variantStrip: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(variants) { variant in
                    Button {
                        Task { await model.pick(variant, api: api) }
                    } label: {
                        SmmRemoteImage(path: variant.url)
                            .frame(width: 54, height: 66)
                            .clipShape(.rect(cornerRadius: 10))
                            .overlay {
                                if variant.selected {
                                    RoundedRectangle(cornerRadius: 10).stroke(Color.accentColor, lineWidth: 2)
                                }
                            }
                            .opacity(variant.selected ? 1 : 0.6)
                    }
                    .buttonStyle(.plain)
                    .disabled(isActing)
                    .accessibilityLabel(variant.selected ? "Выбранный вариант" : "Выбрать вариант")
                }
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
    }

    // MARK: Actions

    private var actions: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                Button(model.acting == .image ? "Рисую…" : "Новый вариант", systemImage: "wand.and.stars") {
                    Task { await model.regenerate(mediaId: currentImageId, api: api) }
                }
                .disabled(model.isBusy || isActing)
                Button("Описать картинку", systemImage: "text.bubble") {
                    imagePrompt = ""
                    describes = true
                }
                .disabled(model.isBusy || isActing)
                NavigationLink(value: SmmRoute.library(postId: post.id)) {
                    Label("Из архива", systemImage: "photo.stack")
                }
                .disabled(!isEditable || isActing)
                uploadButton
                Button("Видео ИИ", systemImage: "film") {
                    videoWish = ""
                    asksVideo = true
                }
                .disabled(model.isBusy || isActing || hasPendingVideo)
                if media.count > 1, isEditable {
                    NavigationLink(value: SmmRoute.mediaOrder(postId: post.id)) {
                        Label("Порядок", systemImage: "arrow.up.arrow.down")
                    }
                    .disabled(model.isBusy || isActing)
                }
                if let current, current.status == .done, let url = api.mediaURL(for: current.url) {
                    ShareLink(
                        item: SmmMediaFile(url: url, isVideo: current.isVideo),
                        preview: SharePreview(current.isVideo ? "Видео публикации" : "Картинка публикации")
                    ) {
                        Label("Сохранить", systemImage: "square.and.arrow.down")
                    }
                }
                if let current, !current.isPending, isEditable {
                    Button(model.acting == .remove ? "Убираю…" : "Убрать", systemImage: "trash", role: .destructive) {
                        confirmsRemove = true
                    }
                    .disabled(model.isBusy || isActing)
                }
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .controlSize(.small)
            .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
    }

    private var uploadButton: some View {
        // The picker label closure is Sendable, so the title is computed outside it.
        let title = model.acting == .upload ? "Загружаю…" : "Своё фото/видео"
        return PhotosPicker(
            selection: $pickerItem,
            matching: .any(of: [.images, .videos]),
            preferredItemEncoding: .compatible,
            photoLibrary: .shared()
        ) {
            Label(title, systemImage: "square.and.arrow.up.on.square")
        }
        .disabled(!isEditable || isActing)
    }

    private var currentImageId: String? {
        guard let current, current.kind == .image else { return nil }
        return current.id
    }

    private var removeTitle: String {
        guard let current else { return "Убрать?" }
        if current.isVideo { return "Убрать видео?" }
        if media.count > 1 { return "Убрать \(post.format == .story ? "кадр" : "слайд") \(currentIndex + 1)?" }
        return "Убрать картинку?"
    }

    private func drawDescribed() {
        let prompt = imagePrompt.trimmed
        guard !prompt.isEmpty else { return }
        Task { await model.regenerate(prompt: prompt, mediaId: currentImageId, api: api) }
    }

    private func startVideo() {
        let wish = videoWish
        Task { await model.makeVideo(wish: wish, api: api) }
    }

    private func removeCurrent() {
        guard let current else { return }
        let index = currentIndex
        Task {
            if await model.remove(current, api: api) {
                let remaining = model.post?.selectedMedia ?? []
                pageId = remaining.isEmpty ? nil : remaining[max(0, min(index, remaining.count - 1))].id
            }
        }
    }

    private static func videoMessage(profile: SmmProfile) -> String {
        let place = profile == .studio ? "если сюжет в студии — в нужном месте съёмки" : "если сюжет в знакомом месте — в нём"
        return "Маркетолог продумает сцену, сделает реалистичный первый кадр (\(place)) и оживит его: 8 секунд со звуком, "
            + "вертикально, около 48 ₽, пара минут. Можно написать, что должно быть в ролике."
    }
}

/// One frame of the pager: the picture, a playable video, or the marketer at work on it.
private struct SmmMediaFrame: View {
    let media: SmmMedia

    var body: some View {
        switch media.status {
        case .pending:
            pending
        default:
            if media.isVideo {
                SmmVideoFrame(media: media)
            } else {
                SmmRemoteImage(path: media.url)
            }
        }
    }

    private var pending: some View {
        ZStack {
            LinearGradient(
                colors: [Color(white: 0.11), Color.accentColor.opacity(0.35)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            VStack(spacing: 10) {
                Image(systemName: media.isVideo ? "film" : "sparkles")
                    .font(.system(size: 34))
                    .foregroundStyle(.white)
                    .symbolEffect(.pulse)
                Text(label)
                    .font(.headline)
                    .foregroundStyle(.white)
                if media.isVideo {
                    Text("Пара минут — можно уйти с экрана")
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.75))
                }
                ProgressView()
                    .tint(.white)
            }
            .padding()
        }
        .accessibilityElement(children: .combine)
    }

    private var label: String {
        if media.isVideo { return "Снимаю видео" }
        return media.source == .archive ? "Беру фото из архива" : "Рисую картинку"
    }
}

/// A ready video played in place; the player is created on first show.
private struct SmmVideoFrame: View {
    @Environment(APIClient.self) private var api
    let media: SmmMedia
    @State private var player: AVPlayer?

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black
            if let player {
                VideoPlayer(player: player)
            } else {
                Image(systemName: "play.circle.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Text(media.source == .ai ? "Видео нейросети" : "Ваше видео")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.black.opacity(0.5), in: .capsule)
                .padding(10)
                .allowsHitTesting(false)
        }
        .onAppear {
            if player == nil, let url = api.mediaURL(for: media.url) {
                player = AVPlayer(url: url)
            }
        }
        .onDisappear { player?.pause() }
        .accessibilityLabel(media.source == .ai ? "Видео нейросети" : "Ваше видео")
    }
}
