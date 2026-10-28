import Foundation

/// `loyalty` of `GET /reports/analytics` (docs/API.md «Analytics»): bonus and gift certificate ledger operations of the
/// period; the `…Outstanding` values are balances at its end. 1 bonus = 1 ₽.
nonisolated struct AnalyticsLoyalty: Hashable, Sendable {
    /// Cashback earned minus what refunds took back, plus gifts and manual adjustments (signed).
    var bonusEarned = 0
    /// Paid with bonuses minus what refunds gave back.
    var bonusSpent = 0
    /// Burnt at expiry.
    var bonusExpired = 0
    /// On the clients' accounts at the end of the period.
    var bonusOutstanding = 0
    /// Nominals of the certificates sold.
    var certificatesSold = 0
    /// Spent at checkout minus what refunds gave back.
    var certificatesRedeemed = 0
    /// Burnt at expiry.
    var certificatesExpired = 0
    /// Burnt by the owner or by refunding the sale that sold the certificate.
    var certificatesCancelled = 0
    /// Σ certificate balances at the end of the period.
    var certificatesOutstanding = 0

    static let zero = AnalyticsLoyalty()

    var hasBonuses: Bool {
        bonusEarned != 0 || bonusSpent != 0 || bonusExpired != 0 || bonusOutstanding != 0
    }

    var hasCertificates: Bool {
        certificatesSold != 0 || certificatesRedeemed != 0 || certificatesExpired != 0 || certificatesCancelled != 0
            || certificatesOutstanding != 0
    }

    /// Nothing to show: the card is hidden.
    var isZero: Bool { !hasBonuses && !hasCertificates }

    /// Something moved in the period (balances left over from earlier do not count).
    var hasActivity: Bool {
        bonusEarned != 0 || bonusSpent != 0 || bonusExpired != 0 || certificatesSold != 0 || certificatesRedeemed != 0
            || certificatesExpired != 0 || certificatesCancelled != 0
    }
}

nonisolated extension AnalyticsLoyalty: Decodable {
    private enum CodingKeys: String, CodingKey {
        case bonusEarned, bonusSpent, bonusExpired, bonusOutstanding
        case certificatesSold, certificatesRedeemed, certificatesExpired, certificatesCancelled, certificatesOutstanding
    }

    /// A number another server version does not send reads as 0.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        bonusEarned = try c.decode(.bonusEarned, or: 0)
        bonusSpent = try c.decode(.bonusSpent, or: 0)
        bonusExpired = try c.decode(.bonusExpired, or: 0)
        bonusOutstanding = try c.decode(.bonusOutstanding, or: 0)
        certificatesSold = try c.decode(.certificatesSold, or: 0)
        certificatesRedeemed = try c.decode(.certificatesRedeemed, or: 0)
        certificatesExpired = try c.decode(.certificatesExpired, or: 0)
        certificatesCancelled = try c.decode(.certificatesCancelled, or: 0)
        certificatesOutstanding = try c.decode(.certificatesOutstanding, or: 0)
    }
}
