import Foundation

/// The button under a campaign message, as the editor offers it.
nonisolated enum CampaignButtonChoice: String, CaseIterable, Hashable, Sendable {
    case none
    case book
    case link

    var title: String {
        switch self {
        case .none: "Без кнопки"
        case .book: "Записаться"
        case .link: "Ссылка"
        }
    }
}

/// The campaign editor's state: message, picture, button and segment.
nonisolated struct CampaignDraft: Hashable, Sendable {
    static let maxButtonTitleLength = 64
    static let defaultLinkTitle = "Подробнее"
    static let linkPrefix = "https://"

    var title = ""
    var text = ""
    /// `/uploads/…`; `nil` — a text message.
    var imageUrl: String?
    var buttonChoice: CampaignButtonChoice = .book
    var linkTitle = CampaignDraft.defaultLinkTitle
    var linkURL = CampaignDraft.linkPrefix
    var segment = CampaignSegmentDraft()

    init() {}

    init(campaign: Campaign) {
        title = campaign.title
        text = campaign.text
        imageUrl = campaign.imageUrl.nonEmpty
        switch campaign.button?.kind {
        case nil:
            buttonChoice = .none
        case .book:
            buttonChoice = .book
        case .url:
            buttonChoice = .link
            linkTitle = campaign.button?.text ?? Self.defaultLinkTitle
            linkURL = campaign.button?.url ?? Self.linkPrefix
        }
        segment = CampaignSegmentDraft(segment: campaign.segment)
    }

    var hasImage: Bool { imageUrl != nil }

    var button: CampaignButton? {
        switch buttonChoice {
        case .none: nil
        case .book: .book
        case .link: CampaignButton(text: linkTitle.trimmed, kind: .url, url: linkURL.trimmed)
        }
    }

    var titleIssue: String? {
        if title.trimmed.isEmpty { return "Назовите рассылку — название видно только сотрудникам." }
        if title.trimmed.utf16.count > CampaignText.maxTitleLength {
            return "Название — не длиннее \(CampaignText.maxTitleLength) символов."
        }
        return nil
    }

    var textIssue: String? { CampaignText.issue(text, hasImage: hasImage) }

    var buttonIssue: String? {
        guard buttonChoice == .link else { return nil }
        if linkTitle.trimmed.isEmpty { return "Напишите текст кнопки." }
        if linkTitle.trimmed.utf16.count > Self.maxButtonTitleLength {
            return "Текст кнопки — не длиннее \(Self.maxButtonTitleLength) символов."
        }
        if !Self.isValidLink(linkURL) { return "Ссылка должна начинаться с https:// и вести на сайт." }
        return nil
    }

    /// The first thing to fix before saving, or `nil`.
    var issue: String? { titleIssue ?? textIssue ?? buttonIssue ?? segment.issue }

    var body: CampaignBody {
        CampaignBody(
            title: title.trimmed,
            text: text.trimmed,
            imageUrl: Nullable(imageUrl),
            button: Nullable(button),
            segment: segment.segment
        )
    }

    /// `https://` with a host.
    static func isValidLink(_ text: String) -> Bool {
        guard let url = URL(string: text.trimmed), url.scheme?.lowercased() == "https",
              let host = url.host(), host.contains(".")
        else { return false }
        return true
    }
}
