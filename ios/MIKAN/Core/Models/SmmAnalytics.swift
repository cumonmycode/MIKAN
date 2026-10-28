import Foundation

// Platform numbers of the SMM profiles: account summaries, daily history, best formats/days/hours, forecast accuracy.

/// Telegram channel: views per post, ERR, posts / views / reactions over 30 days.
nonisolated struct SmmTelegramStats: Codable, Hashable, Sendable {
    var avgViews: Int?
    /// Engagement rate by reach, %.
    var err: Double?
    var posts30: Int?
    var views30: Int?
    var reactions30: Int?
    var avgReactions: Double?
}

nonisolated extension SmmTelegramStats {
    private enum CodingKeys: String, CodingKey {
        case avgViews, err, posts30, views30, reactions30, avgReactions
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        avgViews = c.decodeLenient(.avgViews)
        err = c.decodeLenient(.err)
        posts30 = c.decodeLenient(.posts30)
        views30 = c.decodeLenient(.views30)
        reactions30 = c.decodeLenient(.reactions30)
        avgReactions = c.decodeLenient(.avgReactions)
    }
}

/// Instagram profile over a period (7 or 30 days).
nonisolated struct SmmIgPeriod: Codable, Hashable, Sendable {
    var reach: Int?
    var views: Int?
    var engaged: Int?
    var interactions: Int?
    var likes: Int?
    var comments: Int?
    var shares: Int?
    var saves: Int?
    var replies: Int?
    var profileViews: Int?
    var linkTaps: Int?
    var follows: Int?
    var unfollows: Int?
}

nonisolated extension SmmIgPeriod {
    private enum CodingKeys: String, CodingKey {
        case reach, views, engaged, interactions, likes, comments, shares, saves, replies, profileViews, linkTaps
        case follows, unfollows
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reach = c.decodeLenient(.reach)
        views = c.decodeLenient(.views)
        engaged = c.decodeLenient(.engaged)
        interactions = c.decodeLenient(.interactions)
        likes = c.decodeLenient(.likes)
        comments = c.decodeLenient(.comments)
        shares = c.decodeLenient(.shares)
        saves = c.decodeLenient(.saves)
        replies = c.decodeLenient(.replies)
        profileViews = c.decodeLenient(.profileViews)
        linkTaps = c.decodeLenient(.linkTaps)
        follows = c.decodeLenient(.follows)
        unfollows = c.decodeLenient(.unfollows)
    }
}

nonisolated struct SmmAudienceSlice: Codable, Hashable, Identifiable, Sendable {
    let label: String
    let value: Double

    var id: String { label }
}

/// Instagram followers by age, gender and city.
nonisolated struct SmmAudience: Codable, Hashable, Sendable {
    var ages: [SmmAudienceSlice]
    var genders: [SmmAudienceSlice]
    var cities: [SmmAudienceSlice]
}

nonisolated extension SmmAudience {
    private enum CodingKeys: String, CodingKey {
        case ages, genders, cities
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ages = c.decodeLenient(.ages) ?? []
        genders = c.decodeLenient(.genders) ?? []
        cities = c.decodeLenient(.cities) ?? []
    }
}

/// `SmmAccount.stats` — a free-form summary; every part is optional and a malformed one is dropped.
nonisolated struct SmmAccountStats: Codable, Hashable, Sendable {
    var views: Int?
    var posts: Int?
    var engagement: Double?
    var source: String?
    var tg: SmmTelegramStats?
    var period7: SmmIgPeriod?
    var period30: SmmIgPeriod?
    var audience: SmmAudience?

    static let empty = SmmAccountStats()
}

nonisolated extension SmmAccountStats {
    private enum CodingKeys: String, CodingKey {
        case views, posts, engagement, source, tg, period7, period30, audience
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        views = c.decodeLenient(.views)
        posts = c.decodeLenient(.posts)
        engagement = c.decodeLenient(.engagement)
        source = c.decodeLenient(.source)
        tg = c.decodeLenient(.tg)
        period7 = c.decodeLenient(.period7)
        period30 = c.decodeLenient(.period30)
        audience = c.decodeLenient(.audience)
    }
}

/// One day of an account (`day` — `YYYY-MM-DD` in the studio time zone).
nonisolated struct SmmHistoryPoint: Codable, Hashable, Identifiable, Sendable {
    let accountId: String
    let day: String
    let followers: Int?
    let views: Int?
    let reach: Int?
    let newFollowers: Int?

    var id: String { "\(accountId)-\(day)" }
}

/// A post of the platform (by the marketer or not) with its numbers.
nonisolated struct SmmTopPost: Codable, Hashable, Identifiable, Sendable {
    let extId: String
    let format: SmmFormat
    let publishedAt: Date?
    let caption: String
    let permalink: String?
    let thumb: String?
    let views: Int?
    let reach: Int?
    let likes: Int?
    let comments: Int?
    let shares: Int?
    let saves: Int?
    /// Our post, when the marketer made it.
    let postId: String?

    var id: String { extId }
}

nonisolated struct SmmFormatInsight: Codable, Hashable, Identifiable, Sendable {
    let format: SmmFormat
    let posts: Int
    let avgViews: Int
    let avgLikes: Int?

    var id: String { format.rawValue }
}

nonisolated struct SmmWeekdayInsight: Codable, Hashable, Identifiable, Sendable {
    /// 0 — Sunday … 6 — Saturday.
    let weekday: Int
    let posts: Int
    let avgViews: Int

    var id: Int { weekday }
}

nonisolated struct SmmHourInsight: Codable, Hashable, Identifiable, Sendable {
    let from: Int
    let to: Int
    let posts: Int
    let avgViews: Int

    var id: Int { from }
}

/// Best formats, weekdays and hours of one account, and its top posts.
nonisolated struct SmmPlatformInsight: Codable, Hashable, Identifiable, Sendable {
    let accountId: String
    let platform: SmmAccountPlatform
    let posts: Int
    let formats: [SmmFormatInsight]
    let weekdays: [SmmWeekdayInsight]
    let hours: [SmmHourInsight]
    let top: [SmmTopPost]

    var id: String { accountId }
}

/// How published posts landed against the forecast.
nonisolated struct SmmAccuracy: Codable, Hashable, Sendable {
    let posts: Int
    let inside: Int
    let above: Int
    let below: Int
    /// Fact to forecast on average: 1.2 — 20% above expectation.
    let ratio: Double?

    static let zero = SmmAccuracy(posts: 0, inside: 0, above: 0, below: 0, ratio: nil)
}

/// `GET /smm/:profile/analytics` (and `POST …/analytics/collect`).
nonisolated struct SmmAnalytics: Codable, Hashable, Sendable {
    let accounts: [SmmAccount]
    let history: [SmmHistoryPoint]
    let platforms: [SmmPlatformInsight]
    let posts: [SmmPost]
    let accuracy: SmmAccuracy
    let reports: [SmmReport]
    let spend: SmmSpend
}

nonisolated extension SmmAnalytics {
    private enum CodingKeys: String, CodingKey {
        case accounts, history, platforms, posts, accuracy, reports, spend
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accounts = try c.decode(.accounts, or: [])
        history = try c.decode(.history, or: [])
        platforms = try c.decode(.platforms, or: [])
        posts = try c.decode(.posts, or: [])
        accuracy = try c.decode(.accuracy, or: .zero)
        reports = try c.decode(.reports, or: [])
        spend = try c.decode(.spend, or: SmmSpend(month: 0, budget: 0))
    }
}
