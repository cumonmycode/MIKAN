import Foundation

/// `GET /reports/growth` (docs/API.md «Reports»): how the studio grows over a period — the booking funnel, master load
/// against work schedules, retention and monthly cohorts, client value and where new clients come from.
/// Every section and number is optional on the wire: what a server does not send decodes as empty or zero.
nonisolated struct ReportGrowth: Sendable {
    let from: Date
    let to: Date
    var funnel = GrowthFunnel()
    var load: [GrowthMasterLoad] = []
    var retention = GrowthRetention()
    var value = GrowthValue()
    var sources: [GrowthSource] = []

    /// Nothing to show: no requests, bookings, visits or clients.
    var isEmpty: Bool {
        funnel.bookingRequests.created == 0 && funnel.appointments.created == 0 && funnel.online.created == 0
            && retention.newClients == 0 && value.clientsWithVisits == 0
            && load.allSatisfy { $0.bookedMinutes == 0 }
    }
}

nonisolated extension ReportGrowth: Decodable {
    private enum CodingKeys: String, CodingKey {
        case from, to, funnel, load, retention, value, sources
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        from = try c.decode(Date.self, forKey: .from)
        to = try c.decode(Date.self, forKey: .to)
        funnel = try c.decode(.funnel, or: GrowthFunnel())
        load = try c.decodeLossy(.load)
        retention = try c.decode(.retention, or: GrowthRetention())
        value = try c.decode(.value, or: GrowthValue())
        sources = try c.decodeLossy(.sources)
    }
}

// MARK: - Funnel

nonisolated struct GrowthFunnel: Hashable, Sendable {
    var bookingRequests = GrowthRequests()
    var online = GrowthOnline()
    var appointments = GrowthAppointments()
}

nonisolated extension GrowthFunnel: Decodable {
    private enum CodingKeys: String, CodingKey { case bookingRequests, online, appointments }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        bookingRequests = try c.decode(.bookingRequests, or: GrowthRequests())
        online = try c.decode(.online, or: GrowthOnline())
        appointments = try c.decode(.appointments, or: GrowthAppointments())
    }
}

/// Booking requests the bot created in the period.
nonisolated struct GrowthRequests: Hashable, Sendable {
    var created = 0
    var processed = 0
    var rejected = 0
    /// Still `new`.
    var open = 0
}

nonisolated extension GrowthRequests: Decodable {
    private enum CodingKeys: String, CodingKey { case created, processed, rejected, open }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        created = try c.decode(.created, or: 0)
        processed = try c.decode(.processed, or: 0)
        rejected = try c.decode(.rejected, or: 0)
        open = try c.decode(.open, or: 0)
    }
}

/// Online bookings created in the period: `created = confirmed + rejected + expired + cancelledByClient + awaiting`;
/// `completed` is part of `confirmed`.
nonisolated struct GrowthOnline: Hashable, Sendable {
    var created = 0
    /// `bot` | `miniapp` | `web` (and any channel added later).
    var byChannel: [String: Int] = [:]
    var confirmed = 0
    var rejected = 0
    var expired = 0
    var cancelledByClient = 0
    var completed = 0
    var awaiting = 0
}

nonisolated extension GrowthOnline: Decodable {
    private enum CodingKeys: String, CodingKey {
        case created, byChannel, confirmed, rejected, expired, cancelledByClient, completed, awaiting
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        created = try c.decode(.created, or: 0)
        byChannel = (try? c.decode(.byChannel, or: [String: Int]())) ?? [:]
        confirmed = try c.decode(.confirmed, or: 0)
        rejected = try c.decode(.rejected, or: 0)
        expired = try c.decode(.expired, or: 0)
        cancelledByClient = try c.decode(.cancelledByClient, or: 0)
        completed = try c.decode(.completed, or: 0)
        awaiting = try c.decode(.awaiting, or: 0)
    }
}

/// Every appointment created in the period, by channel, and what became of them so far.
nonisolated struct GrowthAppointments: Hashable, Sendable {
    var created = 0
    /// `app` | `bot` | `miniapp` | `web` (and any channel added later).
    var byChannel: [String: Int] = [:]
    var completed = 0
    var cancelled = 0
    var noShow = 0
}

nonisolated extension GrowthAppointments: Decodable {
    private enum CodingKeys: String, CodingKey { case created, byChannel, completed, cancelled, noShow }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        created = try c.decode(.created, or: 0)
        byChannel = (try? c.decode(.byChannel, or: [String: Int]())) ?? [:]
        completed = try c.decode(.completed, or: 0)
        cancelled = try c.decode(.cancelled, or: 0)
        noShow = try c.decode(.noShow, or: 0)
    }
}

// MARK: - Load

/// A master's working time in the period (their schedule, studio hours without one) against the time booked.
nonisolated struct GrowthMasterLoad: Hashable, Identifiable, Sendable {
    let employee: EmployeeRef
    var workingMinutes = 0
    var bookedMinutes = 0
    var completedMinutes = 0
    /// booked / working × 100; `nil` when the master had no working time. May exceed 100.
    var loadPercent: Double?
    /// Monday first.
    var byWeekday: [GrowthWeekdayLoad] = []

    var id: Int { employee.id }
}

nonisolated extension GrowthMasterLoad: Decodable {
    private enum CodingKeys: String, CodingKey {
        case employee, workingMinutes, bookedMinutes, completedMinutes, loadPercent, byWeekday
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        employee = try c.decode(EmployeeRef.self, forKey: .employee)
        workingMinutes = try c.decode(.workingMinutes, or: 0)
        bookedMinutes = try c.decode(.bookedMinutes, or: 0)
        completedMinutes = try c.decode(.completedMinutes, or: 0)
        loadPercent = try c.decodeIfPresent(Double.self, forKey: .loadPercent)
        byWeekday = try c.decodeLossy(.byWeekday)
    }
}

nonisolated struct GrowthWeekdayLoad: Hashable, Identifiable, Sendable {
    /// 1 = Monday … 7 = Sunday, studio time.
    let weekday: Int
    var workingMinutes = 0
    var bookedMinutes = 0

    var id: Int { weekday }
}

nonisolated extension GrowthWeekdayLoad: Decodable {
    private enum CodingKeys: String, CodingKey { case weekday, workingMinutes, bookedMinutes }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        weekday = try c.decode(Int.self, forKey: .weekday)
        workingMinutes = try c.decode(.workingMinutes, or: 0)
        bookedMinutes = try c.decode(.bookedMinutes, or: 0)
    }
}

// MARK: - Retention

nonisolated struct GrowthRetention: Hashable, Sendable {
    /// First completed visit in the period.
    var newClients = 0
    /// Of them, came back on a later day within 90 days.
    var returnedWithin90Days = 0
    /// One decimal; `nil` without new clients.
    var repeatRatePercent: Double?
    /// `nil` when no visit of the period followed an earlier one.
    var averageDaysBetweenVisits: Int?
    /// 12 studio months up to the end of the period, oldest first.
    var cohorts: [GrowthCohort] = []
}

nonisolated extension GrowthRetention: Decodable {
    private enum CodingKeys: String, CodingKey {
        case newClients, returnedWithin90Days, repeatRatePercent, averageDaysBetweenVisits, cohorts
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        newClients = try c.decode(.newClients, or: 0)
        returnedWithin90Days = try c.decode(.returnedWithin90Days, or: 0)
        repeatRatePercent = try c.decodeIfPresent(Double.self, forKey: .repeatRatePercent)
        averageDaysBetweenVisits = try c.decodeIfPresent(Double.self, forKey: .averageDaysBetweenVisits).map { Int($0.rounded()) }
        cohorts = try c.decodeLossy(.cohorts)
    }
}

/// Clients whose first completed visit fell in `month`, and how many came back within 30 / 90 / 180 days.
nonisolated struct GrowthCohort: Hashable, Identifiable, Sendable {
    /// "YYYY-MM", studio time.
    let month: String
    var clients = 0
    var returned30 = 0
    var returned90 = 0
    var returned180 = 0

    var id: String { month }

    /// Returned within `days` (30, 90 or 180).
    func returned(within days: Int) -> Int {
        switch days {
        case ...30: returned30
        case ...90: returned90
        default: returned180
        }
    }
}

nonisolated extension GrowthCohort: Decodable {
    private enum CodingKeys: String, CodingKey { case month, clients, returned30, returned90, returned180 }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        month = try c.decode(String.self, forKey: .month)
        clients = try c.decode(.clients, or: 0)
        returned30 = try c.decode(.returned30, or: 0)
        returned90 = try c.decode(.returned90, or: 0)
        returned180 = try c.decode(.returned180, or: 0)
    }
}

// MARK: - Value and sources

/// Over all time up to the end of the period.
nonisolated struct GrowthValue: Hashable, Sendable {
    /// Clients with a completed visit or a kept sale.
    var clientsWithVisits = 0
    var averageRevenuePerClient = 0
    var averageVisitsPerClient = 0.0
    /// Share of revenue from the top 10 % of clients, one decimal; `nil` without revenue.
    var top10PercentShare: Double?
}

nonisolated extension GrowthValue: Decodable {
    private enum CodingKeys: String, CodingKey {
        case clientsWithVisits, averageRevenuePerClient, averageVisitsPerClient, top10PercentShare
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        clientsWithVisits = try c.decode(.clientsWithVisits, or: 0)
        averageRevenuePerClient = try c.decode(.averageRevenuePerClient, or: 0)
        averageVisitsPerClient = try c.decode(.averageVisitsPerClient, or: 0)
        top10PercentShare = try c.decodeIfPresent(Double.self, forKey: .top10PercentShare)
    }
}

/// New clients of the period by the card's source («не указан» when empty) and the revenue they brought in it.
nonisolated struct GrowthSource: Hashable, Identifiable, Sendable {
    let source: String
    var newClients = 0
    var revenue = 0

    var id: String { source }
}

nonisolated extension GrowthSource: Decodable {
    private enum CodingKeys: String, CodingKey { case source, newClients, revenue }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = try c.decode(.source, or: "")
        newClients = try c.decode(.newClients, or: 0)
        revenue = try c.decode(.revenue, or: 0)
    }
}

// MARK: - Lossy lists

/// Decodes any element and keeps nothing (it reads no container): lets a lossy list step over an element it cannot read.
private nonisolated struct SkippedElement: Decodable {
    init(from decoder: any Decoder) throws {}
}

nonisolated extension KeyedDecodingContainer {
    /// The list at `key`, skipping elements that do not decode; `[]` when the key is absent, `null` or not a list.
    func decodeLossy<T: Decodable>(_ key: Key) throws -> [T] {
        guard contains(key), try !decodeNil(forKey: key), var list = try? nestedUnkeyedContainer(forKey: key) else { return [] }
        var result: [T] = []
        while !list.isAtEnd {
            if let element = try? list.decode(T.self) {
                result.append(element)
            } else if (try? list.decode(SkippedElement.self)) == nil {
                break
            }
        }
        return result
    }
}
