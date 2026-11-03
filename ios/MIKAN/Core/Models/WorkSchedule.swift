import Foundation

/// "HH:MM"–"HH:MM" in the studio time zone ("24:00" = midnight).
nonisolated struct ScheduleTimeRange: Codable, Hashable, Sendable {
    var start: String
    var end: String

    /// "15:00–15:30"
    var title: String { "\(start)–\(end)" }
}

/// Working hours of one day with breaks inside them.
nonisolated struct WorkHours: Codable, Hashable, Sendable {
    var start: String
    var end: String
    var breaks: [ScheduleTimeRange] = []
}

nonisolated extension WorkHours {
    private enum CodingKeys: String, CodingKey { case start, end, breaks }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        start = try c.decode(String.self, forKey: .start)
        end = try c.decode(String.self, forKey: .end)
        breaks = try c.decodeIfPresent([ScheduleTimeRange].self, forKey: .breaks) ?? []
    }
}

/// A master's own schedule (docs/API.md «WorkSchedule»): `weekly` has 7 entries Monday…Sunday (`nil` = day off);
/// `weekly == nil` means no own schedule — the studio hours every day. `days` are the exceptions from today on.
nonisolated struct WorkSchedule: Codable, Hashable, Sendable {
    let employeeId: Int
    var weekly: [WorkHours?]?
    var days: [ScheduleException]
}

/// One date that differs from the weekly schedule: a day off, or other hours.
nonisolated struct ScheduleException: Codable, Hashable, Identifiable, Sendable {
    let date: String
    let off: Bool
    let start: String?
    let end: String?
    let breaks: [ScheduleTimeRange]
    let note: String?

    var id: String { date }
}

nonisolated enum ScheduleSource: String, Codable, Hashable, Sendable {
    case weekly, day, studio

    /// A newer server may add sources: treat them as the studio hours (nothing to shade).
    init(from decoder: Decoder) throws {
        self = ScheduleSource(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .studio
    }
}

/// `ScheduleDayOut`: the working time of one master on one studio date.
nonisolated struct ScheduleDay: Codable, Hashable, Sendable {
    let employeeId: Int
    let date: String
    let working: Bool
    let start: String?
    let end: String?
    let breaks: [ScheduleTimeRange]
    let source: ScheduleSource
    let note: String?

    /// The master has an own schedule that day (the studio hours never limit anyone).
    var isOwn: Bool { source != .studio }
}

/// `PUT /employees/:id/schedule` — `weekly: null` returns the employee to the studio hours.
nonisolated struct WeeklyScheduleBody: Encodable, Sendable {
    let weekly: [WorkHours?]?

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(weekly, forKey: .weekly)
    }

    private enum CodingKeys: String, CodingKey { case weekly }
}

/// `PUT /employees/:id/schedule/days` — sets every date from `from` to `to` (inclusive).
nonisolated struct ScheduleDaysBody: Encodable, Hashable, Sendable {
    let from: String
    let to: String
    let off: Bool
    var start: String?
    var end: String?
    var breaks: [ScheduleTimeRange]?
    var note: String?
}
