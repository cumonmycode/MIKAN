import Foundation

/// A block of the month in the plan (Titan `weeks()`): days 1–7, 8–14, 15–21, 22–28, 29–end, with the posts that go
/// out in it.
nonisolated struct SmmPlanWeek: Identifiable, Hashable, Sendable {
    /// First and last day of the month in the block.
    let start: Int
    let end: Int
    /// «1–7 ноября».
    let title: String
    let posts: [SmmPost]

    var id: Int { start }

    func contains(_ day: Int) -> Bool { (start...end).contains(day) }
}

/// One cell of the month grid: the day and what is planned on it.
nonisolated struct SmmPlanDay: Identifiable, Hashable, Sendable {
    /// `YYYY-MM-DD`.
    let key: String
    let day: Int
    let posts: [SmmPost]
    let dates: [SmmDate]

    var id: String { key }
}

/// Month arithmetic of the plan screen: days of a `YYYY-MM` month, the Monday-first grid, posts by day and by block,
/// counts by platform. Days of posts are taken in the studio time zone.
nonisolated enum SmmPlanMath {
    private static let utc = TimeZone(identifier: "UTC") ?? .gmt

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        return calendar
    }

    private static func parts(_ month: String) -> (year: Int, month: Int)? {
        let pieces = month.split(separator: "-").compactMap { Int($0) }
        guard pieces.count >= 2, (1...12).contains(pieces[1]) else { return nil }
        return (pieces[0], pieces[1])
    }

    private static func firstDay(_ month: String) -> Date? {
        guard let parts = parts(month) else { return nil }
        return calendar.date(from: DateComponents(year: parts.year, month: parts.month, day: 1))
    }

    /// 28…31.
    static func dayCount(_ month: String) -> Int {
        guard let first = firstDay(month), let range = calendar.range(of: .day, in: .month, for: first) else { return 30 }
        return range.count
    }

    /// Empty cells before the 1st in a Monday-first week.
    static func leadingBlanks(_ month: String) -> Int {
        guard let first = firstDay(month) else { return 0 }
        let weekday = calendar.component(.weekday, from: first)
        return (weekday + 5) % 7
    }

    /// `YYYY-MM-DD` of a day of the month.
    static func dayKey(_ month: String, _ day: Int) -> String {
        "\(month)-\(day < 10 ? "0\(day)" : "\(day)")"
    }

    /// Day of the month of a `YYYY-MM-DD` key.
    static func dayNumber(_ key: String) -> Int? {
        key.split(separator: "-").last.flatMap { Int($0) }
    }

    /// Posts in publication order; the ones without a time go last.
    static func ordered(_ posts: [SmmPost]) -> [SmmPost] {
        posts.enumerated()
            .sorted { lhs, rhs in
                switch (lhs.element.publishAt, rhs.element.publishAt) {
                case let (left?, right?) where left != right: left < right
                case (nil, _?): false
                case (_?, nil): true
                default: lhs.offset < rhs.offset
                }
            }
            .map(\.element)
    }

    /// Posts of the month by their day (studio time zone).
    static func byDay(_ posts: [SmmPost], month: String, timeZone: TimeZone) -> [Int: [SmmPost]] {
        var result: [Int: [SmmPost]] = [:]
        for post in ordered(posts) {
            guard let publishAt = post.publishAt else { continue }
            let key = SmmText.dayKey(of: publishAt, in: timeZone)
            guard key.hasPrefix(month), let day = dayNumber(key) else { continue }
            result[day, default: []].append(post)
        }
        return result
    }

    /// Blocks of seven days that have publications, in order (Titan shows only those).
    static func weeks(_ posts: [SmmPost], month: String, timeZone: TimeZone) -> [SmmPlanWeek] {
        let days = byDay(posts, month: month, timeZone: timeZone)
        let total = dayCount(month)
        return stride(from: 1, through: total, by: 7).compactMap { start in
            let end = min(start + 6, total)
            let posts = (start...end).flatMap { days[$0] ?? [] }
            guard !posts.isEmpty else { return nil }
            let title = "\(start)–\(SmmText.dayTitle(dayKey(month, end)))"
            return SmmPlanWeek(start: start, end: end, title: title, posts: posts)
        }
    }

    /// Grid cells of the month: `nil` — a blank before the 1st.
    static func grid(_ posts: [SmmPost], dates: [SmmDate], month: String, timeZone: TimeZone) -> [SmmPlanDay?] {
        let days = byDay(posts, month: month, timeZone: timeZone)
        let blanks: [SmmPlanDay?] = Array(repeating: nil, count: leadingBlanks(month))
        let cells: [SmmPlanDay?] = (1...dayCount(month)).map { day in
            let key = dayKey(month, day)
            return SmmPlanDay(key: key, day: day, posts: days[day] ?? [], dates: dates.filter { $0.date == key })
        }
        return blanks + cells
    }

    /// Occasions of the month that fall on one day (seasons with `until` are left out, as in Titan).
    static func occasions(_ dates: [SmmDate], month: String) -> [SmmDate] {
        dates.filter { $0.until == nil && $0.date.hasPrefix(month) }
    }

    /// Occasions inside a block.
    static func occasions(_ dates: [SmmDate], in week: SmmPlanWeek) -> [SmmDate] {
        dates.filter { date in dayNumber(date.date).map(week.contains) ?? false }
    }

    /// Posts whose time can be swapped: not out yet and with a time.
    static func movable(_ posts: [SmmPost]) -> [SmmPost] {
        ordered(posts).filter { $0.status != .published && $0.publishAt != nil }
    }

    /// «Telegram 12 · Instagram 8 · Рилс 4 · Сторис 6» over the posts that go out.
    static func countsLine(_ posts: [SmmPost]) -> String {
        let live = posts.filter { $0.status != .skipped }
        let telegram = live.filter { $0.platform == .telegram && $0.format != .story }.count
        let instagram = live.filter { $0.platform == .instagram && ($0.format == .post || $0.format == .carousel) }.count
        let reels = live.filter { $0.format == .reel }.count
        let stories = live.filter { $0.format == .story }.count
        return [
            "\(SmmPlatform.telegram.title) \(telegram)",
            "\(SmmPlatform.instagram.title) \(instagram)",
            "\(SmmFormat.reel.title) \(reels)",
            "\(SmmFormat.story.title) \(stories)",
        ].joined(separator: " · ")
    }
}
