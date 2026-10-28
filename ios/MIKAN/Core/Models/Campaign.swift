import Foundation

/// A Telegram campaign (рассылка) to a segment of clients (docs/API.md «Campaigns»). Decoded tolerantly: the server
/// may omit what it does not know yet, and an unknown status or button never breaks the list.
nonisolated struct Campaign: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    var title: String
    /// Light Markdown; `{name}` = the client's first name.
    var text: String
    /// Server-relative picture (`/uploads/…`): sent as a photo with the text as caption.
    var imageUrl: String?
    var button: CampaignButton?
    var segment: CampaignSegment
    var status: CampaignStatus
    var scheduledAt: Date?
    var startedAt: Date?
    var finishedAt: Date?
    var stats: CampaignStats
    var createdBy: EmployeeRef?
    let createdAt: Date
    var updatedAt: Date
}

nonisolated extension Campaign {
    private enum CodingKeys: String, CodingKey {
        case id, title, text, imageUrl, button, segment, status, scheduledAt, startedAt, finishedAt, stats
        case createdBy, createdAt, updatedAt
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        imageUrl = try c.decodeIfPresent(String.self, forKey: .imageUrl)
        // An unknown button kind drops the button rather than the whole campaign.
        button = (try? c.decodeIfPresent(CampaignButton.self, forKey: .button)) ?? nil
        segment = (try? c.decodeIfPresent(CampaignSegment.self, forKey: .segment)) ?? CampaignSegment()
        status = try c.decodeIfPresent(CampaignStatus.self, forKey: .status) ?? .unknown
        scheduledAt = try c.decodeIfPresent(Date.self, forKey: .scheduledAt)
        startedAt = try c.decodeIfPresent(Date.self, forKey: .startedAt)
        finishedAt = try c.decodeIfPresent(Date.self, forKey: .finishedAt)
        stats = try c.decodeIfPresent(CampaignStats.self, forKey: .stats) ?? CampaignStats()
        createdBy = (try? c.decodeIfPresent(EmployeeRef.self, forKey: .createdBy)) ?? nil
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? .distantPast
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? createdAt
    }
}

nonisolated enum CampaignStatus: String, Codable, Hashable, Sendable {
    case draft
    case scheduled
    case sending
    case sent
    case cancelled
    /// A status this build does not know: shown as is and read-only.
    case unknown

    /// Text, picture, button and segment may still change (`PATCH`).
    var isEditable: Bool { self == .draft || self == .scheduled }
    /// «Отправить сейчас» / «Запланировать».
    var canSend: Bool { isEditable }
    /// Stops a scheduled or running campaign (sent messages stay).
    var canCancel: Bool { self == .scheduled || self == .sending }
    /// Only drafts are deleted.
    var canDelete: Bool { self == .draft }
}

nonisolated extension CampaignStatus {
    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CampaignStatus(rawValue: raw) ?? .unknown
    }
}

nonisolated enum CampaignButtonKind: String, Codable, Hashable, Sendable {
    /// «📅 Записаться»: the Mini App when online booking is on, else the bot books with AI.
    case book
    /// Any `https://` link.
    case url
}

/// The inline button under a campaign message.
nonisolated struct CampaignButton: Codable, Hashable, Sendable {
    var text: String
    var kind: CampaignButtonKind
    var url: String?

    static let bookTitle = "📅 Записаться"
    static let book = CampaignButton(text: bookTitle, kind: .book, url: nil)
}

/// Delivery counters of a campaign.
nonisolated struct CampaignStats: Codable, Hashable, Sendable {
    var recipients = 0
    var sent = 0
    var failed = 0
    /// Clients who blocked the bot.
    var blocked = 0
    /// Still in the queue.
    var pending = 0

    /// Messages already attempted (delivered, failed or blocked).
    var processed: Int { sent + failed + blocked }

    /// 0…1 of the recipients processed; 0 without recipients.
    var progress: Double {
        guard recipients > 0 else { return 0 }
        return min(1, Double(processed) / Double(recipients))
    }
}

nonisolated extension CampaignStats {
    private enum CodingKeys: String, CodingKey { case recipients, sent, failed, blocked, pending }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        recipients = try c.decodeIfPresent(Int.self, forKey: .recipients) ?? 0
        sent = try c.decodeIfPresent(Int.self, forKey: .sent) ?? 0
        failed = try c.decodeIfPresent(Int.self, forKey: .failed) ?? 0
        blocked = try c.decodeIfPresent(Int.self, forKey: .blocked) ?? 0
        pending = try c.decodeIfPresent(Int.self, forKey: .pending) ?? 0
    }
}

/// Who receives a campaign: every set condition must hold (AND). Only set conditions are sent — `false` flags and
/// empty lists mean «no condition» and are left out.
nonisolated struct CampaignSegment: Codable, Hashable, Sendable {
    /// The last completed visit was at least this many months ago.
    var lastVisitMonthsAgoMin: Int?
    /// …and at most this many months ago.
    var lastVisitMonthsAgoMax: Int?
    /// Never had a completed visit.
    var neverVisited = false
    /// Had a completed visit with a service of these categories.
    var categories: [ServiceCategory] = []
    /// Had a completed visit with these masters.
    var masterIds: [Int] = []
    var minVisits: Int?
    /// 1…12.
    var birthdayMonth: Int?
    var hasBonuses = false
    /// The card was created within this many days.
    var createdWithinDays: Int?

    /// No condition at all: every client who may get news.
    var isEmpty: Bool { self == CampaignSegment() }
}

nonisolated extension CampaignSegment {
    private enum CodingKeys: String, CodingKey {
        case lastVisitMonthsAgoMin, lastVisitMonthsAgoMax, neverVisited, categories, masterIds, minVisits
        case birthdayMonth, hasBonuses, createdWithinDays
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        lastVisitMonthsAgoMin = try c.decodeIfPresent(Int.self, forKey: .lastVisitMonthsAgoMin)
        lastVisitMonthsAgoMax = try c.decodeIfPresent(Int.self, forKey: .lastVisitMonthsAgoMax)
        neverVisited = try c.decodeIfPresent(Bool.self, forKey: .neverVisited) ?? false
        // Categories this build does not know are skipped.
        let rawCategories = try c.decodeIfPresent([String].self, forKey: .categories) ?? []
        categories = rawCategories.compactMap(ServiceCategory.init(rawValue:))
        masterIds = try c.decodeIfPresent([Int].self, forKey: .masterIds) ?? []
        minVisits = try c.decodeIfPresent(Int.self, forKey: .minVisits)
        birthdayMonth = try c.decodeIfPresent(Int.self, forKey: .birthdayMonth)
        hasBonuses = try c.decodeIfPresent(Bool.self, forKey: .hasBonuses) ?? false
        createdWithinDays = try c.decodeIfPresent(Int.self, forKey: .createdWithinDays)
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(lastVisitMonthsAgoMin, forKey: .lastVisitMonthsAgoMin)
        try c.encodeIfPresent(lastVisitMonthsAgoMax, forKey: .lastVisitMonthsAgoMax)
        if neverVisited { try c.encode(true, forKey: .neverVisited) }
        if !categories.isEmpty { try c.encode(categories, forKey: .categories) }
        if !masterIds.isEmpty { try c.encode(masterIds, forKey: .masterIds) }
        try c.encodeIfPresent(minVisits, forKey: .minVisits)
        try c.encodeIfPresent(birthdayMonth, forKey: .birthdayMonth)
        if hasBonuses { try c.encode(true, forKey: .hasBonuses) }
        try c.encodeIfPresent(createdWithinDays, forKey: .createdWithinDays)
    }
}

/// `POST /campaigns/preview`: how many clients the segment reaches and a few of them.
nonisolated struct CampaignAudience: Codable, Hashable, Sendable {
    var count: Int
    var sample: [ClientRef]
}

nonisolated extension CampaignAudience {
    private enum CodingKeys: String, CodingKey { case count, sample }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        count = try c.decodeIfPresent(Int.self, forKey: .count) ?? 0
        sample = try c.decodeIfPresent([ClientRef].self, forKey: .sample) ?? []
    }
}
