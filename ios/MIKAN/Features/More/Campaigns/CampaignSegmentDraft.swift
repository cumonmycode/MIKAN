import Foundation

/// The segment builder's state. Every condition has its own switch, so turning one off keeps the number for later;
/// `segment` sends only the conditions that are on.
nonisolated struct CampaignSegmentDraft: Hashable, Sendable {
    /// «Не раньше чем … назад»: 0 — no lower bound.
    static let minMonthsRange = 0...120
    static let maxMonthsRange = 1...120
    static let visitsRange = 1...100
    static let newDaysRange = 1...365

    var usesLastVisit = false
    /// Last visit at least this many months ago (0 — any time)…
    var lastVisitMin = 3
    var lastVisitHasMax = false
    /// …and at most this many.
    var lastVisitMax = 12
    var neverVisited = false
    var categories: Set<ServiceCategory> = []
    var masterIds: Set<Int> = []
    var usesMinVisits = false
    var minVisits = 2
    /// 1…12; `nil` — any month.
    var birthdayMonth: Int?
    var hasBonuses = false
    var usesCreatedWithin = false
    var createdWithinDays = 30

    init() {}

    init(segment: CampaignSegment) {
        if segment.lastVisitMonthsAgoMin != nil || segment.lastVisitMonthsAgoMax != nil {
            usesLastVisit = true
            lastVisitMin = segment.lastVisitMonthsAgoMin ?? 0
        }
        if let max = segment.lastVisitMonthsAgoMax {
            lastVisitHasMax = true
            lastVisitMax = max
        }
        neverVisited = segment.neverVisited
        categories = Set(segment.categories)
        masterIds = Set(segment.masterIds)
        if let visits = segment.minVisits {
            usesMinVisits = true
            minVisits = visits
        }
        birthdayMonth = segment.birthdayMonth
        hasBonuses = segment.hasBonuses
        if let days = segment.createdWithinDays {
            usesCreatedWithin = true
            createdWithinDays = days
        }
    }

    /// «Ещё не были у нас» rules out every condition about visits.
    var allowsVisitConditions: Bool { !neverVisited }

    /// What goes to the server: only the conditions that are on.
    var segment: CampaignSegment {
        var result = CampaignSegment()
        if allowsVisitConditions {
            if usesLastVisit {
                result.lastVisitMonthsAgoMin = lastVisitMin > 0 ? lastVisitMin : nil
                result.lastVisitMonthsAgoMax = lastVisitHasMax ? lastVisitMax : nil
            }
            result.categories = ServiceCategory.allCases.filter(categories.contains)
            result.masterIds = masterIds.sorted()
            result.minVisits = usesMinVisits ? minVisits : nil
        }
        result.neverVisited = neverVisited
        result.birthdayMonth = birthdayMonth
        result.hasBonuses = hasBonuses
        result.createdWithinDays = usesCreatedWithin ? createdWithinDays : nil
        return result
    }

    /// Why the segment can't be used, or `nil`.
    var issue: String? {
        guard allowsVisitConditions, usesLastVisit, lastVisitHasMax, lastVisitMax < lastVisitMin else { return nil }
        return "Последний визит: «до» должно быть не меньше, чем «от»."
    }
}

/// Human-readable conditions of a segment, for the campaign card.
nonisolated enum CampaignSegmentText {
    /// "Январь"… for pickers.
    static let months = [
        "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
        "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
    ]
    /// "в январе"…
    private static let monthsIn = [
        "январе", "феврале", "марте", "апреле", "мае", "июне",
        "июле", "августе", "сентябре", "октябре", "ноябре", "декабре",
    ]

    static func month(_ month: Int) -> String {
        months.indices.contains(month - 1) ? months[month - 1] : "\(month)"
    }

    static func months(_ count: Int) -> String {
        Plural.count(count, one: "месяц", few: "месяца", many: "месяцев")
    }

    /// One line per condition; «Все клиенты, которые получают новости» without conditions.
    static func lines(_ segment: CampaignSegment, masterName: (Int) -> String?) -> [String] {
        var lines: [String] = []
        if let line = lastVisit(segment) { lines.append(line) }
        if segment.neverVisited { lines.append("Ещё не были у нас") }
        if !segment.categories.isEmpty {
            lines.append("Были на: " + segment.categories.map { $0.title.lowercased() }.joined(separator: ", "))
        }
        if !segment.masterIds.isEmpty {
            let names = segment.masterIds.map { masterName($0) ?? "мастер №\($0)" }
            lines.append("У мастеров: " + names.joined(separator: ", "))
        }
        if let visits = segment.minVisits {
            lines.append("Визитов: от \(visits)")
        }
        if let month = segment.birthdayMonth {
            let name = monthsIn.indices.contains(month - 1) ? monthsIn[month - 1] : "месяце \(month)"
            lines.append("День рождения в \(name)")
        }
        if segment.hasBonuses { lines.append("Есть бонусы") }
        if let days = segment.createdWithinDays {
            lines.append("Новые: за последние \(Plural.days(days))")
        }
        return lines.isEmpty ? ["Все клиенты, которые получают новости"] : lines
    }

    private static func lastVisit(_ segment: CampaignSegment) -> String? {
        switch (segment.lastVisitMonthsAgoMin, segment.lastVisitMonthsAgoMax) {
        case let (min?, max?): "Последний визит: \(min)–\(max) мес. назад"
        case let (min?, nil): "Последний визит: \(min) мес. назад и раньше"
        case let (nil, max?): "Последний визит: за последние \(max) мес."
        case (nil, nil): nil
        }
    }
}
