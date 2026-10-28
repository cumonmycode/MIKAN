import Foundation

/// `GET /reports/analytics`: the financial picture of a period and the headline numbers of the previous period of the
/// same length. Revenue counts every sale made in the period minus refunds made in it; the breakdowns (items, masters,
/// clients, weekdays, hours) count only the sales that were not refunded (see docs/API.md «Analytics»).
nonisolated struct ReportAnalytics: Decodable, Sendable {
    let from: Date
    let to: Date
    let previousFrom: Date
    let previousTo: Date
    /// Studio time zone the days and hours are bucketed in.
    var timezone: String?
    let totals: AnalyticsTotals
    var previous = AnalyticsTotals.zero
    var revenue = AnalyticsRevenue()
    var byDay: [AnalyticsDay] = []
    /// Always 7 entries, Monday first.
    var byWeekday: [AnalyticsWeekday] = []
    /// Always 24 entries, 0–23.
    var byHour: [AnalyticsHour] = []
    var services = AnalyticsServices()
    var products = AnalyticsProducts()
    var stock = AnalyticsStock()
    var deposits = ReportDeposits.zero
    var cash = AnalyticsCash()
    var masters: [AnalyticsMaster] = []
    var clients = AnalyticsClients()
    var appointments = AnalyticsAppointments()
    /// Bonuses and gift certificates; zero from a server without loyalty.
    var loyalty = AnalyticsLoyalty.zero

    /// Nothing happened in the period: no sales, refunds, appointments, stock or cash movements, prepayments,
    /// bonus or certificate operations.
    var isEmpty: Bool {
        revenue.gross == 0 && revenue.refunds == 0 && revenue.salesCount == 0 && appointments.total == 0
            && stock.expenses == 0 && stock.writeoffs.quantity == 0 && stock.usage.quantity == 0
            && stock.purchases.count == 0 && cash.operationsCount == 0 && cash.shiftsClosed == 0
            && deposits.received == 0 && deposits.applied == 0 && deposits.refunded == 0 && deposits.retained == 0
            && !loyalty.hasActivity
    }
}

nonisolated extension ReportAnalytics {
    private enum CodingKeys: String, CodingKey {
        case from, to, previousFrom, previousTo, timezone, totals, previous, revenue, byDay, byWeekday, byHour
        case services, products, stock, deposits, cash, masters, clients, appointments, loyalty
    }

    /// Sections a server does not send decode as empty, so the screen still shows the rest.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        from = try c.decode(Date.self, forKey: .from)
        to = try c.decode(Date.self, forKey: .to)
        let length = to.timeIntervalSince(from)
        previousFrom = try c.decode(.previousFrom, or: from.addingTimeInterval(-length))
        previousTo = try c.decode(.previousTo, or: from)
        timezone = try c.decodeIfPresent(String.self, forKey: .timezone)
        totals = try c.decode(AnalyticsTotals.self, forKey: .totals)
        previous = try c.decode(.previous, or: .zero)
        revenue = try c.decode(.revenue, or: AnalyticsRevenue())
        byDay = try c.decode(.byDay, or: [])
        byWeekday = try c.decode(.byWeekday, or: [])
        byHour = try c.decode(.byHour, or: [])
        services = try c.decode(.services, or: AnalyticsServices())
        products = try c.decode(.products, or: AnalyticsProducts())
        stock = try c.decode(.stock, or: AnalyticsStock())
        deposits = try c.decode(.deposits, or: .zero)
        cash = try c.decode(.cash, or: AnalyticsCash())
        masters = try c.decode(.masters, or: [])
        clients = try c.decode(.clients, or: AnalyticsClients())
        appointments = try c.decode(.appointments, or: AnalyticsAppointments())
        loyalty = try c.decode(.loyalty, or: .zero)
    }
}

/// Headline numbers of a period; the same shape for the previous one.
nonisolated struct AnalyticsTotals: Hashable, Sendable {
    /// Made sales − refunds («Выручка»).
    var net = 0
    var gross = 0
    var refunds = 0
    var salesCount = 0
    var averageCheck = 0
    var discounts = 0
    var servicesRevenue = 0
    var productsRevenue = 0
    var cogs = 0
    var grossProfit = 0
    /// `nil` when no product with a known cost sold.
    var marginPercent: Double?
    var stockExpenses = 0
    var newClients = 0
    var appointmentsCompleted = 0
    var noShows = 0
    var noShowLoss = 0
    var depositsReceived = 0

    static let zero = AnalyticsTotals()
}

nonisolated extension AnalyticsTotals: Decodable {
    private enum CodingKeys: String, CodingKey {
        case net, gross, refunds, salesCount, averageCheck, discounts, servicesRevenue, productsRevenue, cogs
        case grossProfit, marginPercent, stockExpenses, newClients, appointmentsCompleted, noShows, noShowLoss
        case depositsReceived
    }

    /// Tolerates headline numbers added or dropped by another server version (absent → 0).
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        net = try c.decode(.net, or: 0)
        gross = try c.decode(.gross, or: 0)
        refunds = try c.decode(.refunds, or: 0)
        salesCount = try c.decode(.salesCount, or: 0)
        averageCheck = try c.decode(.averageCheck, or: 0)
        discounts = try c.decode(.discounts, or: 0)
        servicesRevenue = try c.decode(.servicesRevenue, or: 0)
        productsRevenue = try c.decode(.productsRevenue, or: 0)
        cogs = try c.decode(.cogs, or: 0)
        grossProfit = try c.decode(.grossProfit, or: 0)
        marginPercent = try c.decodeIfPresent(Double.self, forKey: .marginPercent)
        stockExpenses = try c.decode(.stockExpenses, or: 0)
        newClients = try c.decode(.newClients, or: 0)
        appointmentsCompleted = try c.decode(.appointmentsCompleted, or: 0)
        noShows = try c.decode(.noShows, or: 0)
        noShowLoss = try c.decode(.noShowLoss, or: 0)
        depositsReceived = try c.decode(.depositsReceived, or: 0)
    }
}

nonisolated struct AnalyticsRevenue: Decodable, Hashable, Sendable {
    /// Σ totals of the sales made in the period (refunded later included).
    var gross = 0
    /// Σ totals of the sales refunded in the period, whenever they were made.
    var refunds = 0
    var refundsCount = 0
    var net = 0
    var salesCount = 0
    var averageCheck = 0
    var discounts = 0
    /// Σ totals of the period's sales that were not refunded (what the breakdowns count).
    var kept = 0
    /// How the made sales were paid (sums to `gross`).
    var payments = Payments(cash: 0, card: 0, transfer: 0)
}

/// One studio-local day: sales made, refunds made and their difference.
nonisolated struct AnalyticsDay: Decodable, Hashable, Identifiable, Sendable {
    /// `YYYY-MM-DD` in the studio time zone.
    let date: String
    var gross = 0
    var refunds = 0
    var net = 0
    var salesCount = 0

    var id: String { date }
}

nonisolated struct AnalyticsWeekday: Decodable, Hashable, Identifiable, Sendable {
    /// 1 = Monday … 7 = Sunday.
    let weekday: Int
    var revenue = 0
    var salesCount = 0

    var id: Int { weekday }
}

nonisolated struct AnalyticsHour: Decodable, Hashable, Identifiable, Sendable {
    /// 0–23, studio time.
    let hour: Int
    var revenue = 0
    var salesCount = 0

    var id: Int { hour }
}

nonisolated extension KeyedDecodingContainer {
    /// The value, or `fallback` when the key is absent or `null`.
    func decode<T: Decodable>(_ key: Key, or fallback: T) throws -> T {
        try decodeIfPresent(T.self, forKey: key) ?? fallback
    }
}
