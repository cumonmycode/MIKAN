import SwiftUI

// Titles, SF Symbols and colors of SMM values. Platform colors appear only on their badges; the rest of the UI keeps
// the single accent.

nonisolated extension SmmAccountPlatform {
    var title: String {
        switch self {
        case .telegram: "Telegram"
        case .instagram: "Instagram"
        case .vk: "VK"
        case .other: "Сайт"
        case .unknown: "Площадка"
        }
    }

    var symbol: String {
        switch self {
        case .telegram: "paperplane.fill"
        case .instagram: "camera.fill"
        case .vk: "person.2.fill"
        case .other: "link"
        case .unknown: "questionmark"
        }
    }

    var tint: Color {
        switch self {
        case .telegram: Color(red: 0.13, green: 0.62, blue: 0.85)
        case .instagram: Color(red: 0.88, green: 0.19, blue: 0.42)
        case .vk: Color(red: 0.0, green: 0.47, blue: 1.0)
        case .other, .unknown: .gray
        }
    }
}

nonisolated extension SmmPlatform {
    var title: String { SmmAccountPlatform(self).title }
    var symbol: String { SmmAccountPlatform(self).symbol }
    var tint: Color { SmmAccountPlatform(self).tint }
}

nonisolated extension SmmFormat {
    var title: String {
        switch self {
        case .post: "Пост"
        case .carousel: "Карусель"
        case .story: "Сторис"
        case .reel: "Рилс"
        case .unknown: "Публикация"
        }
    }

    var symbol: String {
        switch self {
        case .post: "text.below.photo"
        case .carousel: "square.stack"
        case .story: "circle.dashed"
        case .reel: "video"
        case .unknown: "doc.richtext"
        }
    }
}

nonisolated extension SmmBusy {
    /// What the marketer is doing, for the waiting banner.
    var text: String {
        switch self {
        case .text: "Маркетолог пишет текст и рисует картинку…"
        case .image: "Маркетолог рисует картинку…"
        case .video: "Нейросеть снимает видео — это несколько минут…"
        case .revise: "Маркетолог вносит правки…"
        case .plan: "Маркетолог составляет план — около минуты…"
        case .report: "Маркетолог готовит отчёт…"
        case .unknown: "Маркетолог работает…"
        }
    }
}

nonisolated extension SmmDateTone {
    var title: String {
        switch self {
        case .celebrate: "Праздник"
        case .sell: "Повод продать"
        case .fun: "Повод поиграть"
        case .respect: "Уважительно"
        case .mourning: "Траур"
        case .unknown: "Дата"
        }
    }

    var tint: Color {
        switch self {
        case .celebrate: .purple
        case .sell: .green
        case .fun: .orange
        case .respect: .indigo
        case .mourning, .unknown: .gray
        }
    }
}

/// Status of a post: title and system color.
nonisolated struct SmmStatusLook: Hashable, Sendable {
    let title: String
    let color: Color

    init(title: String, color: Color) {
        self.title = title
        self.color = color
    }

    init(_ post: SmmPost) {
        switch (post.busy, post.status) {
        case (.text, _), (.revise, _):
            self.init(title: "Маркетолог пишет", color: .purple)
        case (.image, _):
            self.init(title: "Маркетолог рисует", color: .purple)
        case (_, .idea):
            self.init(title: "Идея", color: .gray)
        case (_, .draft):
            self.init(title: "Черновик", color: .gray)
        case (_, .review):
            self.init(title: "На одобрении", color: .orange)
        case (_, .approved) where post.awaitsLink:
            self.init(title: "Ждём ссылку", color: .orange)
        case (_, .approved):
            self.init(title: post.autoPublishes ? "Выйдет сам" : "Одобрено", color: .green)
        case (_, .published):
            self.init(title: "Вышло", color: .blue)
        case (_, .skipped):
            self.init(title: "Не выкладываем", color: .gray)
        case (_, .failed):
            self.init(title: "Не вышло", color: .red)
        case (_, .unknown):
            self.init(title: "Неизвестно", color: .gray)
        }
    }
}

/// Tinted capsule with the post's status; a spinner while the marketer writes or draws.
struct SmmStatusChip: View {
    let look: SmmStatusLook
    var isWorking = false

    init(look: SmmStatusLook, isWorking: Bool = false) {
        self.look = look
        self.isWorking = isWorking
    }

    init(post: SmmPost) {
        self.init(look: SmmStatusLook(post), isWorking: post.busy != nil && post.busy != .video)
    }

    var body: some View {
        HStack(spacing: 4) {
            if isWorking {
                ProgressView()
                    .controlSize(.mini)
                    .tint(look.color)
            }
            Text(look.title)
        }
        .font(.caption.weight(.semibold))
        .lineLimit(1)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .foregroundStyle(look.color)
        .background(look.color.opacity(0.15), in: .capsule)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(look.title)
    }
}

/// Round badge of a platform in its brand color.
struct SmmPlatformBadge: View {
    let platform: SmmAccountPlatform
    var size: CGFloat = 22

    init(_ platform: SmmAccountPlatform, size: CGFloat = 22) {
        self.platform = platform
        self.size = size
    }

    init(_ platform: SmmPlatform, size: CGFloat = 22) {
        self.init(SmmAccountPlatform(platform), size: size)
    }

    var body: some View {
        Image(systemName: platform.symbol)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(platform.tint, in: .circle)
            .accessibilityLabel(platform.title)
    }
}
