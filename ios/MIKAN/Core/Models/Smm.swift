import Foundation

// «СММ-маркетолог» (docs/SMM.md): two independent profiles — the studio's socials and the author's own — each with
// its platforms, monthly plan, posts, memory, reports and settings. Shapes follow `server/src/smm/types.ts`.

/// `studio` — MIKAN STUDIO's socials; `author` — the author's (Amina's) personal socials, unrelated to studio work.
nonisolated enum SmmProfile: String, Codable, CaseIterable, Identifiable, Sendable {
    case studio
    case author

    var id: String { rawValue }

    /// Switcher title before the profiles load (the author's comes from her `brandName` afterwards).
    var defaultTitle: String {
        switch self {
        case .studio: "Студия"
        case .author: "Амина"
        }
    }
}

/// A server string enum that decodes values it does not know as `unknown` instead of failing the whole response:
/// the server may add statuses, formats or platforms before the app learns them.
nonisolated protocol SmmLenientEnum: RawRepresentable, Codable, Hashable, Sendable where RawValue == String {
    static var unknown: Self { get }
}

nonisolated extension SmmLenientEnum {
    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

nonisolated extension KeyedDecodingContainer {
    /// The value, or `nil` when the key is absent, `null` or of another type (free-form JSON blobs such as stats).
    func decodeLenient<T: Decodable>(_ key: Key) -> T? {
        try? decodeIfPresent(T.self, forKey: key)
    }
}

/// Where a post goes out.
nonisolated enum SmmPlatform: String, SmmLenientEnum {
    case telegram
    case instagram
    case unknown

    static let choices: [SmmPlatform] = [.telegram, .instagram]
}

/// A platform account of the profile (VK and sites are for links and analytics only).
nonisolated enum SmmAccountPlatform: String, SmmLenientEnum {
    case telegram
    case instagram
    case vk
    case other
    case unknown

    static let choices: [SmmAccountPlatform] = [.telegram, .instagram, .vk, .other]

    init(_ platform: SmmPlatform) {
        switch platform {
        case .telegram: self = .telegram
        case .instagram: self = .instagram
        case .unknown: self = .unknown
        }
    }
}

nonisolated enum SmmFormat: String, SmmLenientEnum {
    case post
    case carousel
    case story
    case reel
    case unknown

    static let choices: [SmmFormat] = [.post, .carousel, .story, .reel]
}

/// idea — a topic in the plan; draft — being written, not shown yet; review — waits for approval; approved — goes out
/// on time (Telegram by itself, the rest is handed to a person); published — out (has a link); skipped; failed.
nonisolated enum SmmStatus: String, SmmLenientEnum {
    case idea
    case draft
    case review
    case approved
    case published
    case skipped
    case failed
    case unknown
}

/// What the marketer is doing with a post or plan right now — screens poll while it is set.
nonisolated enum SmmBusy: String, SmmLenientEnum {
    case text
    case image
    case video
    case revise
    case plan
    case report
    case unknown
}

nonisolated enum SmmMemoryKind: String, SmmLenientEnum {
    case voice
    case rule
    case avoid
    case insight
    case fact
    case unknown

    static let choices: [SmmMemoryKind] = [.voice, .rule, .avoid, .insight, .fact]
}

nonisolated enum SmmMemorySource: String, SmmLenientEnum {
    case staff
    case remark
    case analytics
    case unknown
}

nonisolated enum SmmMediaKind: String, SmmLenientEnum {
    case image
    case video
    case unknown
}

/// archive — a photo from the profile's photo archive (Google Drive), as is.
nonisolated enum SmmMediaSource: String, SmmLenientEnum {
    case ai
    case upload
    case archive
    case unknown
}

nonisolated enum SmmMediaStatus: String, SmmLenientEnum {
    case pending
    case done
    case failed
    case unknown
}

/// staff — an employee's remark; ai — the marketer's answer.
nonisolated enum SmmCommentRole: String, SmmLenientEnum {
    case staff
    case ai
    case unknown
}

nonisolated enum SmmPlanStatus: String, SmmLenientEnum {
    case draft
    case active
    case unknown
}

// MARK: - Progress and forecast

/// Readiness scale: the stage and where it leads. The app eases the bar from `pct` to `next` over `eta` seconds
/// since `at`, so it keeps moving between polls.
nonisolated struct SmmProgress: Codable, Hashable, Sendable {
    let label: String
    let pct: Double
    let next: Double
    let eta: Double
    let at: Date

    /// For a request the app awaits itself (ideas, report): the stage starts now.
    static func estimate(_ label: String, eta: Double, now: Date = .now) -> SmmProgress {
        SmmProgress(label: label, pct: 2, next: 96, eta: eta, at: now)
    }
}

/// Expected views from similar posts of the platform (median and spread); frozen when the post goes out.
nonisolated struct SmmForecast: Codable, Hashable, Sendable {
    let metric: String
    let expected: Int
    let low: Int
    let high: Int
    /// How many posts of the platform it was computed on.
    let basis: Int
    let likes: Int?
    let at: Date
    var frozen: Bool?
}

// MARK: - Posts

nonisolated struct SmmMedia: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let kind: SmmMediaKind
    let source: SmmMediaSource
    var status: SmmMediaStatus
    /// `/uploads/smm-…` of our server or an archive link — resolve with `APIClient.mediaURL(for:)`.
    var url: String?
    var aspect: String?
    var prompt: String?
    var model: String?
    var costRub: Double
    var error: String?
    var selected: Bool
    var sort: Int
    let createdAt: Date

    var isVideo: Bool { kind == .video }
    var isPending: Bool { status == .pending }
}

/// One shot of a reel or story series script.
nonisolated struct SmmShot: Codable, Hashable, Sendable {
    var text: String
    var seconds: Double?
    var overlay: String?
    var sticker: String?
}

/// Script of a reel or a story series: staff shoot it, the marketer writes it.
nonisolated struct SmmScript: Codable, Hashable, Sendable {
    var hook: String
    /// Hook formula (reels).
    var formula: String?
    var shots: [SmmShot]
    var audio: String?
    var cast: String?
    var tips: String?
}

nonisolated struct SmmPostStats: Codable, Hashable, Sendable {
    var views: Int?
    var likes: Int?
    var comments: Int?
    var shares: Int?
    var saves: Int?
    var reach: Int?
    var reactions: Int?
    var interactions: Int?
    var source: String?

    static let empty = SmmPostStats()
}

nonisolated extension SmmPostStats {
    private enum CodingKeys: String, CodingKey {
        case views, likes, comments, shares, saves, reach, reactions, interactions, source
    }

    /// Free-form JSON on the server: a value of an unexpected type is dropped, not fatal.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        views = c.decodeLenient(.views)
        likes = c.decodeLenient(.likes)
        comments = c.decodeLenient(.comments)
        shares = c.decodeLenient(.shares)
        saves = c.decodeLenient(.saves)
        reach = c.decodeLenient(.reach)
        reactions = c.decodeLenient(.reactions)
        interactions = c.decodeLenient(.interactions)
        source = c.decodeLenient(.source)
    }
}

nonisolated struct SmmPost: Codable, Hashable, Identifiable, Sendable {
    let id: String
    var profile: SmmProfile?
    var planId: String?
    var accountId: String?
    var platform: SmmPlatform
    var format: SmmFormat
    var status: SmmStatus
    var publishAt: Date?
    var topic: String
    var pillar: String?
    /// Key of the profile's direction (`SmmMeta.directions`).
    var direction: String?
    var brief: String
    /// Telegram HTML; `SmmText.plainText` strips it for previews and Instagram.
    var body: String
    var visual: String
    var script: SmmScript?
    /// The employee who posts by hand (Instagram without the API, stories, reels).
    var assigneeId: Int?
    var assigneeName: String?
    var approvedBy: Int?
    var approvedAt: Date?
    var handoffAt: Date?
    var publishedAt: Date?
    var publishedUrl: String?
    var stats: SmmPostStats
    var statsAt: Date?
    var busy: SmmBusy?
    var progress: SmmProgress?
    var error: String?
    var media: [SmmMedia]
    /// Frozen at publication or computed now.
    var forecast: SmmForecast?
    /// Id on the platform (Instagram media id).
    var extId: String?
    var createdAt: Date?
    var updatedAt: Date
    /// Whether the marketer posts it by itself (Telegram, Instagram via the API) — computed by the server.
    var autoPublish: Bool?

    /// Media that go out, in order: picked variants that are ready or being made.
    var selectedMedia: [SmmMedia] {
        media.filter { $0.selected && ($0.status == .done || $0.status == .pending) }.sorted { $0.sort < $1.sort }
    }

    /// The marketer posts it by itself; older answers without `autoPublish` — only Telegram posts and carousels.
    var autoPublishes: Bool {
        autoPublish ?? (platform == .telegram && (format == .post || format == .carousel))
    }

    /// Handed to a person and waiting for the link to the published post.
    var awaitsLink: Bool { status == .approved && handoffAt != nil && publishedUrl == nil }

    /// The server is still working on it: poll until it is not.
    var isWorking: Bool { busy != nil || media.contains { $0.status == .pending } }
}

nonisolated extension SmmPost {
    private enum CodingKeys: String, CodingKey {
        case id, profile, planId, accountId, platform, format, status, publishAt, topic, pillar, direction, brief, body
        case visual, script, assigneeId, assigneeName, approvedBy, approvedAt, handoffAt, publishedAt, publishedUrl
        case stats, statsAt, busy, progress, error, media, forecast, extId, createdAt, updatedAt, autoPublish
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        profile = c.decodeLenient(.profile)
        planId = try c.decodeIfPresent(String.self, forKey: .planId)
        accountId = try c.decodeIfPresent(String.self, forKey: .accountId)
        platform = try c.decode(.platform, or: .unknown)
        format = try c.decode(.format, or: .unknown)
        status = try c.decode(.status, or: .unknown)
        publishAt = try c.decodeIfPresent(Date.self, forKey: .publishAt)
        topic = try c.decode(.topic, or: "")
        pillar = try c.decodeIfPresent(String.self, forKey: .pillar)
        direction = try c.decodeIfPresent(String.self, forKey: .direction)
        brief = try c.decode(.brief, or: "")
        body = try c.decode(.body, or: "")
        visual = try c.decode(.visual, or: "")
        script = c.decodeLenient(.script)
        assigneeId = try c.decodeIfPresent(Int.self, forKey: .assigneeId)
        assigneeName = try c.decodeIfPresent(String.self, forKey: .assigneeName)
        approvedBy = try c.decodeIfPresent(Int.self, forKey: .approvedBy)
        approvedAt = try c.decodeIfPresent(Date.self, forKey: .approvedAt)
        handoffAt = try c.decodeIfPresent(Date.self, forKey: .handoffAt)
        publishedAt = try c.decodeIfPresent(Date.self, forKey: .publishedAt)
        publishedUrl = try c.decodeIfPresent(String.self, forKey: .publishedUrl)
        stats = try c.decode(.stats, or: .empty)
        statsAt = try c.decodeIfPresent(Date.self, forKey: .statsAt)
        busy = try c.decodeIfPresent(SmmBusy.self, forKey: .busy)
        progress = c.decodeLenient(.progress)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        media = try c.decode(.media, or: [])
        forecast = c.decodeLenient(.forecast)
        extId = try c.decodeIfPresent(String.self, forKey: .extId)
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        autoPublish = try c.decodeIfPresent(Bool.self, forKey: .autoPublish)
    }
}

/// An employee's remark or the marketer's answer on a post or plan.
nonisolated struct SmmComment: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    var postId: String?
    var planId: String?
    let authorName: String?
    let role: SmmCommentRole
    let text: String
    let createdAt: Date

    var isMarketer: Bool { role == .ai }
}

// MARK: - Plan

/// A rubric of the monthly plan with its share of posts.
nonisolated struct SmmPillar: Codable, Hashable, Identifiable, Sendable {
    let key: String
    let title: String
    let share: Double
    let about: String

    var id: String { key }
}

nonisolated struct SmmPlan: Codable, Hashable, Identifiable, Sendable {
    let id: String
    var profile: SmmProfile?
    /// `YYYY-MM`.
    let month: String
    var status: SmmPlanStatus
    var summary: String
    var goals: [String]
    var pillars: [SmmPillar]
    var busy: SmmBusy?
    var progress: SmmProgress?
    var error: String?
    var updatedAt: Date
}

// MARK: - Accounts, memory, reports

nonisolated struct SmmAccount: Codable, Hashable, Identifiable, Sendable {
    let id: String
    var profile: SmmProfile?
    let platform: SmmAccountPlatform
    var title: String
    var url: String?
    var handle: String?
    /// Telegram channel chat (`@username` or `-100…`).
    var tgChatId: String?
    /// The bot can post to the channel.
    var canPublish: Bool
    var isActive: Bool
    var followers: Int?
    var stats: SmmAccountStats
    var statsAt: Date?
    var statsError: String?
}

nonisolated extension SmmAccount {
    private enum CodingKeys: String, CodingKey {
        case id, profile, platform, title, url, handle, tgChatId, canPublish, isActive, followers, stats, statsAt
        case statsError
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        profile = c.decodeLenient(.profile)
        platform = try c.decode(.platform, or: .unknown)
        title = try c.decode(.title, or: "")
        url = try c.decodeIfPresent(String.self, forKey: .url)
        handle = try c.decodeIfPresent(String.self, forKey: .handle)
        tgChatId = c.decodeLenient(.tgChatId)
        canPublish = try c.decode(.canPublish, or: false)
        isActive = try c.decode(.isActive, or: true)
        followers = c.decodeLenient(.followers)
        stats = c.decodeLenient(.stats) ?? .empty
        statsAt = try c.decodeIfPresent(Date.self, forKey: .statsAt)
        statsError = try c.decodeIfPresent(String.self, forKey: .statsError)
    }
}

nonisolated struct SmmMemory: Codable, Hashable, Identifiable, Sendable {
    let id: String
    let kind: SmmMemoryKind
    let text: String
    let source: SmmMemorySource
    let createdAt: Date
}

nonisolated struct SmmReportMetric: Codable, Hashable, Identifiable, Sendable {
    let label: String
    let value: String
    var delta: Double?

    var id: String { label }
}

nonisolated struct SmmRecommendation: Codable, Hashable, Identifiable, Sendable {
    let title: String
    let detail: String

    var id: String { title }
}

nonisolated struct SmmReport: Codable, Hashable, Identifiable, Sendable {
    let id: String
    /// `YYYY-MM-DD`.
    let periodFrom: String
    /// `YYYY-MM-DD`.
    let periodTo: String
    let title: String
    let summary: String
    let metrics: [SmmReportMetric]
    let recommendations: [SmmRecommendation]
    let createdAt: Date
}

// MARK: - Home

/// `GET /smm/profiles` item — the switcher and the badges.
nonisolated struct SmmProfileSummary: Codable, Hashable, Identifiable, Sendable {
    let profile: SmmProfile
    var brandName: String
    var enabled: Bool
    /// Posts waiting for approval.
    var review: Int
    var awaitingLink: Int
    var failed: Int

    var id: SmmProfile { profile }
}

nonisolated struct SmmCounts: Codable, Hashable, Sendable {
    let review: Int
    let awaitingLink: Int
    let failed: Int
    let publishedWeek: Int

    static let zero = SmmCounts(review: 0, awaitingLink: 0, failed: 0, publishedWeek: 0)
}

/// Neural network spend this month and the budget (0 — unlimited), ₽.
nonisolated struct SmmSpend: Codable, Hashable, Sendable {
    let month: Int
    let budget: Int
}

/// What is connected: the Telegram channel (bot can post), Instagram, who posts by hand, approvers with Telegram.
nonisolated struct SmmReadiness: Codable, Hashable, Sendable {
    let channel: Bool
    let instagram: Bool
    let publisher: Bool
    let approvers: Int
}

/// `GET /smm/:profile/overview`: the next two weeks, what waits for a person, this and next month's plan.
nonisolated struct SmmOverview: Codable, Hashable, Sendable {
    /// `YYYY-MM`.
    let month: String
    let nextMonth: String
    let upcoming: [SmmPost]
    let counts: SmmCounts
    let plan: SmmPlan?
    let nextPlan: SmmPlan?
    let accounts: [SmmAccount]
    let lastReport: SmmReport?
    let spend: SmmSpend
    /// Polza balance, ₽.
    let balance: Double?
    let ready: SmmReadiness
    let autopilot: Bool
}

// MARK: - Settings

/// Posts per week.
nonisolated struct SmmCadence: Codable, Hashable, Sendable {
    var telegram: Int
    var instagram: Int
    var stories: Int
    var reels: Int
}

/// Settings of one profile (`server/src/smm/settings.ts`).
nonisolated struct SmmSettings: Codable, Hashable, Sendable {
    /// The profile is run: the marketer prepares and posts. A disabled profile is left alone.
    var enabled: Bool
    /// Brand name in texts and captions: «MIKAN STUDIO», «Амина».
    var brandName: String
    /// Telegram without approval: posts by itself, sends a preview a few hours ahead.
    var autopilot: Bool
    var voice: String
    var audience: String
    var goals: String
    /// What the profile writes about — one direction per line.
    var directions: String
    var cadence: SmmCadence
    /// Default time, `HH:mm` in the studio time zone.
    var postTime: String
    /// Who approves; empty — every employee linked to the bot (for the author — nobody: add yourself).
    var approverIds: [Int]
    /// Who posts Instagram without the API, stories and reels; `nil` — the first approver.
    var publisherId: Int?
    /// How many hours before going out the marketer sends the post for approval.
    var reviewLeadHours: Int
    /// Monthly neural network budget, ₽ (0 — unlimited).
    var monthlyBudget: Int
}

nonisolated struct SmmModels: Codable, Hashable, Sendable {
    let text: String
    let image: String
    let video: String
}

/// `GET /smm/:profile/settings` and every settings/accounts write.
nonisolated struct SmmSettingsPayload: Codable, Hashable, Sendable {
    let settings: SmmSettings
    let accounts: [SmmAccount]
    let spend: SmmSpend
    let balance: Double?
    let models: SmmModels?
}

/// `GET /smm/:profile/people` item: who can approve or post; `telegram` — has a private chat with the bot.
nonisolated struct SmmPerson: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let name: String
    let telegram: Bool
}

// MARK: - Meta, ideas, Instagram

nonisolated struct SmmDirection: Codable, Hashable, Identifiable, Sendable {
    let key: String
    let title: String

    var id: String { key }
}

nonisolated extension SmmDirection {
    private enum CodingKeys: String, CodingKey {
        case key, title, label
    }

    /// Titan sent `label`; MIKAN sends `title`.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? c.decode(String.self, forKey: .label)
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(key, forKey: .key)
        try c.encode(title, forKey: .title)
    }
}

nonisolated struct SmmOption: Codable, Hashable, Identifiable, Sendable {
    let key: String
    let label: String

    var id: String { key }
}

/// `GET /smm/:profile/meta`: the profile's directions, platforms, formats and models.
nonisolated struct SmmMeta: Codable, Hashable, Sendable {
    let directions: [SmmDirection]
    var platforms: [SmmOption]?
    var formats: [SmmOption]?
    var models: SmmModels?

    func direction(_ key: String?) -> SmmDirection? {
        guard let key else { return nil }
        return directions.first { $0.key == key }
    }
}

nonisolated struct SmmIdea: Codable, Hashable, Identifiable, Sendable {
    let topic: String
    let brief: String
    let platform: SmmPlatform
    let format: SmmFormat
    let direction: String

    var id: String { "\(platform.rawValue)-\(format.rawValue)-\(topic)" }
}

nonisolated struct SmmInstagramState: Codable, Hashable, Sendable {
    let userId: String
    let username: String
    let name: String?
    let accountType: String?
    let tokenSetAt: Date
    let expiresAt: Date
    let error: String?
}

nonisolated struct SmmInstagram: Codable, Hashable, Sendable {
    let connected: Bool
    let state: SmmInstagramState?
}

// MARK: - Response envelopes

/// Every post write answers with the fresh post.
nonisolated struct SmmPostResponse: Decodable, Sendable {
    let post: SmmPost
}

/// `GET /smm/:profile/posts/:id`.
nonisolated struct SmmPostPayload: Decodable, Hashable, Sendable {
    var post: SmmPost
    var comments: [SmmComment]
    /// The current employee may approve and publish (MIKAN has no SMM roles — normally `true`).
    var canApprove: Bool
}

nonisolated extension SmmPostPayload {
    private enum CodingKeys: String, CodingKey {
        case post, comments, canApprove
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        post = try c.decode(SmmPost.self, forKey: .post)
        comments = try c.decode(.comments, or: [])
        canApprove = try c.decode(.canApprove, or: true)
    }
}

/// `GET /smm/:profile/plans/:month` and every plan write.
nonisolated struct SmmPlanPayload: Decodable, Hashable, Sendable {
    var plan: SmmPlan?
    var posts: [SmmPost]
    var comments: [SmmComment]
    /// Holidays and occasions of the month — captions for the plan's days.
    var dates: [SmmDate]
}

nonisolated extension SmmPlanPayload {
    private enum CodingKeys: String, CodingKey {
        case plan, posts, comments, dates
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        plan = try c.decodeIfPresent(SmmPlan.self, forKey: .plan)
        posts = try c.decode(.posts, or: [])
        comments = try c.decode(.comments, or: [])
        dates = c.decodeLenient(.dates) ?? []
    }
}

nonisolated struct SmmPostsResponse: Decodable, Sendable {
    let posts: [SmmPost]
}

nonisolated struct SmmIdeasResponse: Decodable, Sendable {
    let ideas: [SmmIdea]
}

nonisolated struct SmmMemoryResponse: Decodable, Sendable {
    let memory: [SmmMemory]
}

nonisolated struct SmmReportResponse: Decodable, Sendable {
    let report: SmmReport
}

nonisolated struct SmmPhotosResponse: Decodable, Sendable {
    let photos: [SmmLibraryPhoto]
}
