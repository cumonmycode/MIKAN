import Foundation

/// `GET/PUT /settings/retention` (docs/API.md «Retention settings»): loyalty bonuses, the birthday greeting, win-back
/// messages and gift certificate validity. The app always sends every group in full; the server validates each field
/// (see `RetentionRules`).
nonisolated struct RetentionSettings: Codable, Hashable, Sendable {
    var loyalty: LoyaltySettings
    var birthday: BirthdaySettings
    var winback: WinbackSettings
    var certificates: CertificateSettings
}

nonisolated struct LoyaltySettings: Codable, Hashable, Sendable {
    /// Off — nothing is earned or spent; balances stay.
    var enabled: Bool
    /// Share of the paid amount credited as bonuses.
    var cashbackPercent: Int
    /// At most this share of a check may be paid with bonuses.
    var maxPaymentPercent: Int
    /// Earned bonuses burn after this many days; `nil` — never.
    var expiryDays: Int?
    /// The bot tells the client what was credited after a paid sale.
    var notifyClient: Bool

    private enum CodingKeys: String, CodingKey { case enabled, cashbackPercent, maxPaymentPercent, expiryDays, notifyClient }

    /// `expiryDays: null` is sent explicitly: an omitted field would keep the old value.
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(enabled, forKey: .enabled)
        try c.encode(cashbackPercent, forKey: .cashbackPercent)
        try c.encode(maxPaymentPercent, forKey: .maxPaymentPercent)
        try c.encode(Nullable(expiryDays), forKey: .expiryDays)
        try c.encode(notifyClient, forKey: .notifyClient)
    }
}

nonisolated struct BirthdaySettings: Codable, Hashable, Sendable {
    var enabled: Bool
    /// "HH:MM" studio time.
    var sendAt: String
    /// `{name}` — the client's first name.
    var text: String
    /// Gift bonuses, 0 — none; they burn after `bonusDays`.
    var bonusAmount: Int
    var bonusDays: Int
    /// The checkout discount around the birthday, 0 — none.
    var discountPercent: Int
    var discountDaysBefore: Int
    var discountDaysAfter: Int
}

nonisolated struct WinbackSettings: Codable, Hashable, Sendable {
    var enabled: Bool
    /// One message once the last completed visit is at least this many months ago.
    var afterMonths: Int
    /// "HH:MM" studio time.
    var sendAt: String
    var text: String
    var bonusAmount: Int
    var bonusDays: Int
    /// At most this many win-back messages a day.
    var dailyLimit: Int
}

nonisolated struct CertificateSettings: Codable, Hashable, Sendable {
    /// A new certificate is valid this many months; `nil` — never expires.
    var validityMonths: Int?

    private enum CodingKeys: String, CodingKey { case validityMonths }

    /// `validityMonths: null` is sent explicitly: an omitted field would keep the old value.
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Nullable(validityMonths), forKey: .validityMonths)
    }
}
