import Foundation

/// `Client.loyalty` — filled by `GET /clients/:id` (`nil` in lists and from a server without loyalty).
nonisolated struct ClientLoyalty: Codable, Hashable, Sendable {
    /// Bonuses on the account (1 bonus = 1 ₽).
    var bonusBalance: Int
    /// The nearest lot that burns, `nil` when none.
    var expiring: BonusExpiring?
    /// Set while today is inside the client's birthday window: staff may give this discount at checkout.
    var birthdayDiscount: BirthdayDiscount?
}

nonisolated extension ClientLoyalty {
    /// Unreadable parts read as none, so the card still opens.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        bonusBalance = max(0, try c.decodeIfPresent(Int.self, forKey: .bonusBalance) ?? 0)
        expiring = try? c.decodeIfPresent(BonusExpiring.self, forKey: .expiring)
        birthdayDiscount = try? c.decodeIfPresent(BirthdayDiscount.self, forKey: .birthdayDiscount)
    }
}

nonisolated struct BonusExpiring: Codable, Hashable, Sendable {
    let amount: Int
    let at: Date
}

nonisolated struct BirthdayDiscount: Codable, Hashable, Sendable {
    let percent: Int
    /// Last day of the window, `YYYY-MM-DD`.
    let until: String
}

/// One entry of a client's bonus ledger (`GET /clients/:id/bonuses`).
nonisolated struct BonusOperation: Decodable, Hashable, Identifiable, Sendable {
    let id: Int
    let type: BonusOperationType
    /// As the server sends it; `BonusLedger.signedAmount` shows it as a credit or a debit.
    let amount: Int
    /// Unspent part of a credited lot.
    var remaining: Int?
    /// When the lot burns; `nil` — never.
    var expiresAt: Date?
    var saleId: Int?
    var saleNumber: Int?
    var note: String?
    var employee: EmployeeRef?
    let createdAt: Date
}

nonisolated enum BonusOperationType: String, Codable, Sendable {
    /// Cashback for a sale.
    case earn
    /// Paid at checkout.
    case spend
    /// Birthday or win-back present.
    case gift
    /// A lot burnt.
    case expire
    /// Staff added or took bonuses by hand.
    case adjust
    /// A refund returned spent bonuses or took back earned ones.
    case reverse
    /// A type from a newer server.
    case unknown
}

nonisolated extension BonusOperationType {
    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = BonusOperationType(rawValue: raw) ?? .unknown
    }
}

/// `GET /clients/:id/bonuses`: the balance and a page of the ledger, newest first.
nonisolated struct BonusHistoryPage: Decodable, Sendable {
    let balance: Int
    let items: [BonusOperation]
    let total: Int?
}

/// What checkout needs of the retention settings (`RetentionSettings`, `APIClient.retentionSettings()`): whether
/// bonuses work and how much of a receipt they may pay, and how long a sold certificate is valid.
nonisolated struct CheckoutLoyaltyRules: Hashable, Sendable {
    var loyaltyEnabled = false
    var cashbackPercent = 0
    /// Bonuses may pay at most this share of a receipt (0…100).
    var maxPaymentPercent = 0
    /// `nil` — certificates never expire.
    var certificateValidityMonths: Int? = 12

    static let off = CheckoutLoyaltyRules()
}

nonisolated extension CheckoutLoyaltyRules {
    init(_ settings: RetentionSettings) {
        self.init(
            loyaltyEnabled: settings.loyalty.enabled,
            cashbackPercent: settings.loyalty.cashbackPercent,
            maxPaymentPercent: settings.loyalty.maxPaymentPercent,
            certificateValidityMonths: settings.certificates.validityMonths
        )
    }
}

nonisolated extension Permissions {
    /// Add or take a client's bonuses by hand (`POST /clients/:id/bonuses`).
    var adjustsBonuses: Bool { role != .master }
    /// Cancel a gift certificate (its balance burns).
    var cancelsCertificates: Bool { role == .owner }
    /// Fix a certificate's recipient and note: a till action, open to every role (docs/API.md «Roles»).
    var editsCertificateDetails: Bool { true }
    /// Change until when a certificate is valid, or make it never expire.
    var changesCertificateExpiry: Bool { role == .owner }
}
