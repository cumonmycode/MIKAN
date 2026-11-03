import SwiftUI

/// Remote picture filling its frame: a server path (`/uploads/smm-…`) or an absolute link (archive previews).
struct SmmRemoteImage: View {
    @Environment(APIClient.self) private var api
    let path: String?
    var placeholderSymbol = "photo"

    var body: some View {
        Color(.tertiarySystemFill)
            .overlay {
                if let url = api.mediaURL(for: path) {
                    AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.2))) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFill()
                        case .failure:
                            symbol("photo.badge.exclamationmark")
                        default:
                            ProgressView()
                        }
                    }
                } else {
                    symbol(placeholderSymbol)
                }
            }
            .clipped()
            .accessibilityHidden(true)
    }

    private func symbol(_ name: String) -> some View {
        Image(systemName: name)
            .font(.title3)
            .foregroundStyle(.secondary)
    }
}

/// Square tiles in columns: archive photos, a post's media, zone photos. A tile shows a corner badge
/// (`play.fill` for videos) and a spinner while busy.
struct SmmPhotoGrid<Item: Identifiable>: View {
    let items: [Item]
    var columns: Int
    var spacing: CGFloat
    let path: (Item) -> String?
    let placeholderSymbol: (Item) -> String
    let badgeSymbol: (Item) -> String?
    let isBusy: (Item) -> Bool
    let label: (Item) -> String
    let onSelect: (Item) -> Void

    init(
        items: [Item],
        columns: Int = 3,
        spacing: CGFloat = 4,
        path: @escaping (Item) -> String?,
        placeholderSymbol: @escaping (Item) -> String = { _ in "photo" },
        badgeSymbol: @escaping (Item) -> String? = { _ in nil },
        isBusy: @escaping (Item) -> Bool = { _ in false },
        label: @escaping (Item) -> String = { _ in "Фото" },
        onSelect: @escaping (Item) -> Void
    ) {
        self.items = items
        self.columns = columns
        self.spacing = spacing
        self.path = path
        self.placeholderSymbol = placeholderSymbol
        self.badgeSymbol = badgeSymbol
        self.isBusy = isBusy
        self.label = label
        self.onSelect = onSelect
    }

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: spacing), count: max(columns, 1)), spacing: spacing) {
            ForEach(items) { item in
                Button { onSelect(item) } label: { tile(item) }
                    .buttonStyle(.plain)
                    .disabled(isBusy(item))
                    .accessibilityLabel(label(item))
            }
        }
    }

    private func tile(_ item: Item) -> some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay { SmmRemoteImage(path: path(item), placeholderSymbol: placeholderSymbol(item)) }
            .overlay(alignment: .bottomTrailing) {
                if let symbol = badgeSymbol(item) {
                    Image(systemName: symbol)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(width: 22, height: 22)
                        .background(.black.opacity(0.55), in: .circle)
                        .padding(5)
                }
            }
            .overlay {
                if isBusy(item) {
                    ZStack {
                        Color.black.opacity(0.4)
                        ProgressView().tint(.white)
                    }
                }
            }
            .clipShape(.rect(cornerRadius: 8))
            .contentShape(.rect(cornerRadius: 8))
    }
}

extension SmmPhotoGrid where Item == SmmLibraryPhoto {
    /// Archive photos; `busyId` — the one being added to a post.
    init(photos: [SmmLibraryPhoto], busyId: String? = nil, onSelect: @escaping (SmmLibraryPhoto) -> Void) {
        self.init(
            items: photos,
            path: { $0.thumb },
            badgeSymbol: { $0.kind == .video ? "play.fill" : nil },
            isBusy: { $0.id == busyId },
            label: { $0.description.nonEmpty ?? $0.name },
            onSelect: onSelect
        )
    }
}

extension SmmPhotoGrid where Item == SmmMedia {
    /// A post's media: videos show a play badge, files still being made — a spinner.
    init(media: [SmmMedia], columns: Int = 3, onSelect: @escaping (SmmMedia) -> Void) {
        self.init(
            items: media,
            columns: columns,
            path: { $0.isVideo ? nil : $0.url },
            placeholderSymbol: { $0.isVideo ? "video" : "photo" },
            badgeSymbol: { $0.isVideo ? "play.fill" : nil },
            isBusy: { $0.isPending },
            label: { $0.isVideo ? "Видео" : "Картинка" },
            onSelect: onSelect
        )
    }
}

extension SmmPhotoGrid where Item == SmmZonePhoto {
    init(zonePhotos: [SmmZonePhoto], onSelect: @escaping (SmmZonePhoto) -> Void) {
        self.init(items: zonePhotos, path: { $0.url }, label: { _ in "Фото места съёмки" }, onSelect: onSelect)
    }
}

/// Thumbnail of a post: its first picture, a play badge for video, the format's symbol without a visual,
/// a dimmed spinner while the visual is being made.
struct SmmPostThumb: View {
    let post: SmmPost
    var size: CGFloat = 64

    var body: some View {
        let media = post.selectedMedia
        let image = media.first { $0.kind == .image && $0.url != nil }
        let hasVideo = media.contains(where: \.isVideo)
        let isMaking = media.contains(where: \.isPending) || post.busy == .image || post.busy == .text
        SmmRemoteImage(path: image?.url, placeholderSymbol: post.format.symbol)
            .frame(width: size, height: size)
            .overlay(alignment: .bottomTrailing) {
                if hasVideo {
                    Image(systemName: "play.fill")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 20, height: 20)
                        .background(.black.opacity(0.55), in: .circle)
                        .padding(4)
                }
            }
            .overlay {
                if isMaking {
                    ZStack {
                        Color.black.opacity(0.3)
                        ProgressView().tint(.white)
                    }
                }
            }
            .clipShape(.rect(cornerRadius: 12))
            .accessibilityHidden(true)
    }
}

/// Forecast and fact in one line: «👁 310 · прогноз 220» after publication, «Прогноз ~220 просмотров» before.
nonisolated struct SmmForecastLine: Sendable {
    let text: String
    /// Above the forecast range — green, below — orange, otherwise secondary.
    let tone: Tone

    nonisolated enum Tone: Sendable {
        case neutral, above, below
    }

    init?(_ post: SmmPost) {
        let forecast = post.forecast
        if post.status == .published, let views = post.stats.views {
            guard let forecast else {
                self.init(text: "👁 \(SmmText.count(views))", tone: .neutral)
                return
            }
            let tone: Tone = views > forecast.high ? .above : (views < forecast.low ? .below : .neutral)
            self.init(text: "👁 \(SmmText.count(views)) · прогноз \(SmmText.count(forecast.expected))", tone: tone)
            return
        }
        guard post.status != .skipped, let forecast else { return nil }
        self.init(text: "Прогноз ~\(SmmText.count(forecast.expected)) просмотров", tone: .neutral)
    }

    private init(text: String, tone: Tone) {
        self.text = text
        self.tone = tone
    }

    var color: Color {
        switch tone {
        case .neutral: .secondary
        case .above: .green
        case .below: .orange
        }
    }
}

/// Feed row of a post: thumbnail, platform · format · time, topic, status, forecast and the marketer's live
/// progress. Wrap it in `NavigationLink(value: SmmRoute.post(id:))`.
struct SmmPostRow: View {
    let post: SmmPost
    /// Studio time zone (`ReferenceStore.workday.timeZone`).
    let timeZone: TimeZone
    /// Shows the day before the time (plan, analytics); the home feed groups by day and shows only the time.
    var showsDay = false

    var body: some View {
        HStack(spacing: 12) {
            SmmPostThumb(post: post)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    SmmPlatformBadge(post.platform, size: 18)
                    Text(meta)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Text(post.topic)
                    .font(.headline)
                    .strikethrough(post.status == .skipped)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    SmmStatusChip(post: post)
                    if let line = SmmForecastLine(post) {
                        Text(line.text)
                            .font(.caption)
                            .foregroundStyle(line.color)
                            .lineLimit(1)
                    }
                }
                if post.busy != nil, let progress = post.progress {
                    SmmLiveProgressBar(progress: progress, thin: true)
                        .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .opacity(post.status == .skipped ? 0.5 : 1)
        .accessibilityElement(children: .combine)
    }

    private var meta: String {
        var parts = [post.platform.title, post.format.title]
        if let publishAt = post.publishAt {
            let time = SmmText.timeKey(of: publishAt, in: timeZone)
            parts.append(showsDay ? "\(SmmText.dayTitle(SmmText.dayKey(of: publishAt, in: timeZone))) \(time)" : time)
        }
        return parts.joined(separator: " · ")
    }
}

/// The marketer's answers and staff remarks on a post or plan.
struct SmmThread: View {
    let comments: [SmmComment]

    var body: some View {
        VStack(spacing: 8) {
            ForEach(comments) { comment in
                bubble(comment)
                    .padding(comment.isMarketer ? .trailing : .leading, 40)
                    .frame(maxWidth: .infinity, alignment: comment.isMarketer ? .leading : .trailing)
            }
        }
    }

    private func bubble(_ comment: SmmComment) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(comment.isMarketer ? "Маркетолог" : (comment.authorName.nonEmpty ?? "Сотрудник"),
                  systemImage: comment.isMarketer ? "sparkles" : "person")
                .font(.caption.weight(.medium))
                .foregroundStyle(comment.isMarketer ? Color.accentColor : .secondary)
            Text(comment.text)
                .font(.subheadline)
                .textSelection(.enabled)
        }
        .padding(12)
        .background(
            comment.isMarketer ? Color(.secondarySystemGroupedBackground) : Color(.tertiarySystemFill),
            in: .rect(cornerRadius: 16)
        )
        .accessibilityElement(children: .combine)
    }
}
