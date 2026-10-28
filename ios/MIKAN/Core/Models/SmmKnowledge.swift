import Foundation

// What the marketer knows about a profile: the brand portrait, what was in the socials, shooting places (zones),
// tattoo & piercing reference, the holiday calendar with own dates, and the profile's photo archive.

/// Documents of the knowledge base: `brand` — the portrait (staff words + what the marketer collected),
/// `socials` — what was posted before.
nonisolated enum SmmKnowledgeKey: String, Codable, Sendable {
    case brand
    case socials
}

nonisolated struct SmmKnowledgeMeta: Codable, Hashable, Sendable {
    var facts: [String]?
    var counts: [String: Int]?
    var posts: Int?
    var studiedAt: String?
    var composedAt: String?

    static let empty = SmmKnowledgeMeta()
}

nonisolated extension SmmKnowledgeMeta {
    private enum CodingKeys: String, CodingKey {
        case facts, counts, posts, studiedAt, composedAt
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        facts = c.decodeLenient(.facts)
        counts = c.decodeLenient(.counts)
        posts = c.decodeLenient(.posts)
        studiedAt = c.decodeLenient(.studiedAt)
        composedAt = c.decodeLenient(.composedAt)
    }
}

nonisolated struct SmmKnowledgeDoc: Codable, Hashable, Sendable {
    let key: String
    /// Written by staff — the main source of the portrait.
    var ownerText: String
    /// Collected and written by the marketer.
    var aiText: String
    var meta: SmmKnowledgeMeta
    var progress: SmmProgress?
    var error: String?
    var aiAt: Date?
    /// Only `socials`: posts collected per platform.
    var posts: [String: Int]?
}

nonisolated extension SmmKnowledgeDoc {
    private enum CodingKeys: String, CodingKey {
        case key, ownerText, aiText, meta, progress, error, aiAt, posts
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(.key, or: "")
        ownerText = try c.decode(.ownerText, or: "")
        aiText = try c.decode(.aiText, or: "")
        meta = c.decodeLenient(.meta) ?? .empty
        progress = c.decodeLenient(.progress)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        aiAt = try c.decodeIfPresent(Date.self, forKey: .aiAt)
        posts = c.decodeLenient(.posts)
    }
}

nonisolated struct SmmZonePhoto: Codable, Hashable, Identifiable, Sendable {
    let id: String
    /// `/uploads/smm-…` — resolve with `APIClient.mediaURL(for:)`.
    let url: String
}

/// A shooting place of the profile (a studio room, a corner of the author's flat) with photos and descriptions.
nonisolated struct SmmZone: Codable, Hashable, Identifiable, Sendable {
    let id: String
    var profile: SmmProfile?
    /// Code for prompts: «З1», «З2»… by order.
    let code: String
    var title: String
    var sort: Int?
    var ownerText: String
    var aiText: String
    /// The same briefly in English — an anchor for the video model.
    var anchor: String
    var photos: [SmmZonePhoto]
    var progress: SmmProgress?
    var error: String?
    var aiAt: Date?
}

nonisolated enum SmmDateTone: String, SmmLenientEnum {
    case celebrate
    case sell
    case fun
    case respect
    case mourning
    case unknown
}

/// A holiday, occasion or own date of the profile.
nonisolated struct SmmDate: Codable, Hashable, Identifiable, Sendable {
    /// `YYYY-MM-DD`; a season's first day.
    let date: String
    /// A season's last day.
    var until: String?
    let title: String
    let tone: SmmDateTone
    /// 3 — a themed post is required, 2 — desirable, 1 — if possible.
    let weight: Int
    let note: String
    /// An own date of the profile, not a built-in one.
    var own: Bool?
    var ownId: String?

    var id: String { ownId ?? "\(date)-\(title)" }

    private enum CodingKeys: String, CodingKey {
        case date, until, title, tone, weight, note, own
        case ownId = "id"
    }
}

/// An own date: `day` — `YYYY-MM-DD` once or `MM-DD` every year.
nonisolated struct SmmOwnDate: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let day: String
    let title: String
    let note: String

    var isYearly: Bool { day.count == 5 }
}

nonisolated struct SmmCraftSection: Codable, Hashable, Identifiable, Sendable {
    let title: String
    let text: String

    var id: String { title }
}

/// Tattoo & piercing reference the marketer leans on.
nonisolated struct SmmCraft: Codable, Hashable, Sendable {
    let source: String
    let sections: [SmmCraftSection]
}

nonisolated struct SmmKnowledgeDates: Codable, Hashable, Sendable {
    /// Next three months.
    let upcoming: [SmmDate]
    let own: [SmmOwnDate]
}

/// `GET /smm/:profile/knowledge` and every knowledge write.
nonisolated struct SmmKnowledge: Decodable, Hashable, Sendable {
    var brand: SmmKnowledgeDoc
    var socials: SmmKnowledgeDoc
    var zones: [SmmZone]
    var craft: SmmCraft?
    var dates: SmmKnowledgeDates

    /// The marketer is studying something: poll until it is not.
    var isWorking: Bool {
        brand.progress != nil || socials.progress != nil || zones.contains { $0.progress != nil }
    }
}

nonisolated extension SmmKnowledge {
    private enum CodingKeys: String, CodingKey {
        case brand, club, socials, zones, craft, mafia, dates
    }

    /// Titan's keys (`club`, `mafia`) are accepted too.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        brand = try c.decodeIfPresent(SmmKnowledgeDoc.self, forKey: .brand) ?? c.decode(SmmKnowledgeDoc.self, forKey: .club)
        socials = try c.decode(SmmKnowledgeDoc.self, forKey: .socials)
        zones = try c.decode(.zones, or: [])
        craft = c.decodeLenient(.craft) ?? c.decodeLenient(.mafia)
        dates = c.decodeLenient(.dates) ?? SmmKnowledgeDates(upcoming: [], own: [])
    }
}

// MARK: - Photo archive (Google Drive)

nonisolated enum SmmLibraryKind: String, SmmLenientEnum {
    case photo
    case video
    case template
    case logo
    case design
    case unknown
}

nonisolated struct SmmLibraryPhoto: Codable, Hashable, Identifiable, Sendable {
    /// Google Drive file id.
    let id: String
    /// Album path, «Альбом / Подальбом».
    let path: String
    let name: String
    let kind: SmmLibraryKind
    /// What is in the picture (written by the marketer).
    let description: String
    let tags: String
    let people: Int?
    let quality: Double?
    let orientation: String?
    let usedCount: Int
    /// Preview URL (absolute).
    let thumb: String

    /// The original in Google Drive.
    var driveURL: URL? { URL(string: "https://drive.google.com/file/d/\(id)/view") }
}

nonisolated struct SmmAlbum: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let path: String
    let title: String
    let kind: String
    let about: String
    let files: Int
    let described: Int
    let cover: String?
}

nonisolated struct SmmLibraryState: Codable, Hashable, Sendable {
    let folderId: String
    let url: String
    let title: String
    let connectedAt: Date
    let syncedAt: Date?
    let error: String?
    let progress: SmmProgress?
}

nonisolated struct SmmLibraryCounts: Codable, Hashable, Sendable {
    let albums: Int
    let files: Int
    let described: Int

    static let zero = SmmLibraryCounts(albums: 0, files: 0, described: 0)
}

/// `GET /smm/:profile/library` and every archive write.
nonisolated struct SmmLibrary: Codable, Hashable, Sendable {
    let connected: Bool
    let state: SmmLibraryState?
    let counts: SmmLibraryCounts
    let albums: [SmmAlbum]
}
