import Foundation

/// Kind of a sale line. Responses carry `product` or `service` — a gift certificate sold in the sale is a `service`
/// line with `certificateId` (see `SaleItem.isCertificate`); `certificate` is only sent to sell one. A value from a
/// newer server reads as `unknown`, so the sale still shows.
nonisolated enum SaleItemType: String, Codable, Sendable {
    case product
    case service
    case certificate
    case unknown
}

nonisolated extension SaleItemType {
    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SaleItemType(rawValue: raw) ?? .unknown
    }
}

nonisolated enum SaleStatus: String, Codable, Sendable {
    case completed
    case refunded
}

/// A gift certificate spent at checkout: its code and how much of it (`POST /sales` → `payments.certificates`).
nonisolated struct CertificatePayment: Codable, Hashable, Sendable {
    let code: String
    let amount: Int
}

nonisolated struct Payments: Hashable, Sendable {
    var cash: Int
    var card: Int
    var transfer: Int
    /// Confirmed SBP QR payment; the server rejects it in `POST /sales` (see `QrPayment`).
    var qr: Int = 0
    /// Part of the total covered by the appointment's prepayment (received earlier, not cash in the drawer now).
    /// Always sent with a sale (0 when none), so the server knows the app accounts for prepayments.
    var deposit: Int = 0
    /// Paid with the client's loyalty bonuses (1 bonus = 1 ₽).
    var bonus: Int = 0
    /// Paid with gift certificates: Σ `certificates` at checkout; responses carry only this sum.
    var certificate: Int = 0
    /// Checkout only: the codes spent and how much of each (sent as `payments.certificates`).
    var certificates: [CertificatePayment] = []

    var total: Int { cash + card + transfer + qr + deposit + bonus + certificate }
    /// Money taken at this checkout (everything except the prepayment, bonuses and certificates).
    var paidNow: Int { cash + card + transfer + qr }
}

nonisolated extension Payments: Codable {
    private enum CodingKeys: String, CodingKey {
        case cash, card, transfer, qr, deposit, bonus, certificate, certificates
    }

    /// Tolerates a server without QR payments (no `qr` key), prepayments (no `deposit`) or loyalty (no `bonus`,
    /// `certificate`).
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            cash: try c.decode(Int.self, forKey: .cash),
            card: try c.decode(Int.self, forKey: .card),
            transfer: try c.decode(Int.self, forKey: .transfer),
            qr: try c.decodeIfPresent(Int.self, forKey: .qr) ?? 0,
            deposit: try c.decodeIfPresent(Int.self, forKey: .deposit) ?? 0,
            bonus: try c.decodeIfPresent(Int.self, forKey: .bonus) ?? 0,
            certificate: try c.decodeIfPresent(Int.self, forKey: .certificate) ?? 0,
            certificates: (try? c.decodeIfPresent([CertificatePayment].self, forKey: .certificates)) ?? []
        )
    }

    /// The `POST /sales` shape: the methods and the prepayment always; `bonus` and `certificates` only when used,
    /// so an ordinary sale reads exactly as before. The certificate sum is the server's to compute.
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(cash, forKey: .cash)
        try c.encode(card, forKey: .card)
        try c.encode(transfer, forKey: .transfer)
        try c.encode(qr, forKey: .qr)
        try c.encode(deposit, forKey: .deposit)
        if bonus > 0 { try c.encode(bonus, forKey: .bonus) }
        if !certificates.isEmpty { try c.encode(certificates, forKey: .certificates) }
    }
}

nonisolated struct SaleItem: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let type: SaleItemType
    let productId: Int?
    /// The size sold (product items).
    var variantId: Int? = nil
    /// Name of that size at the moment of sale; `nil` for services, a product without sizes and older sales.
    var variantName: String? = nil
    let serviceId: Int?
    /// «Лабрет — 8 мм» for a product sold in a size; «Подарочный сертификат MIKAN-7K3Q-9F2D» for a certificate.
    let name: String
    let quantity: Int
    let price: Int
    let total: Int
    /// The gift certificate this line issued; `nil` for every other line.
    var certificateId: Int? = nil
    /// Its code «MIKAN-7K3Q-9F2D»; `nil` for other lines and from servers that only name it in `name`.
    var certificateCode: String? = nil
    /// Units of the line returned by refunds so far; `nil` from a server without partial refunds.
    var refundedQuantity: Int? = nil

    /// A gift certificate sold in the sale (whatever `type` the server gave the line).
    var isCertificate: Bool { certificateId != nil || type == .certificate }
    /// The issued certificate's code: `certificateCode`, else (older servers) read from the line's name.
    var issuedCertificateCode: String? {
        guard isCertificate else { return nil }
        return certificateCode.nonEmpty ?? CertificateCode.find(in: name)
    }
}

nonisolated struct Sale: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let number: Int
    let client: ClientRef?
    let employee: EmployeeRef
    let appointmentId: Int?
    let shiftId: Int?
    let items: [SaleItem]
    let subtotal: Int
    let discount: Int
    let total: Int
    let payments: Payments
    var status: SaleStatus
    let note: String?
    var refundedAt: Date?
    var refundReason: String?
    let createdAt: Date
    /// Bonuses credited for this sale; `nil` from a server without loyalty.
    var bonusEarned: Int? = nil
    /// What refunds have returned so far; `nil` from a server without partial refunds.
    var refundedTotal: Int? = nil
    /// The refunds of this sale, oldest first; `nil` from a server without partial refunds.
    var refunds: [SaleRefund]? = nil
    /// When the bot last sent the receipt to the client's Telegram; `nil` — never (or an older server).
    var receiptSentAt: Date? = nil

    var isRefunded: Bool { status == .refunded }
    /// Returned so far: `refundedTotal`, or the whole total of a refunded sale from an older server.
    var returnedAmount: Int { refundedTotal ?? (isRefunded ? total : 0) }
    /// Some of the sale is returned, some kept.
    var isPartlyRefunded: Bool { !isRefunded && returnedAmount > 0 }
    /// Units of a line returned so far (all of them on a refunded sale from an older server).
    func returnedQuantity(of item: SaleItem) -> Int { item.refundedQuantity ?? (isRefunded ? item.quantity : 0) }
    /// Units of a line that can still be returned.
    func refundableQuantity(of item: SaleItem) -> Int { max(0, item.quantity - returnedQuantity(of: item)) }
    var hasProducts: Bool { items.contains { $0.type == .product && !$0.isCertificate } }
    var itemsSummary: String { items.map(\.name).joined(separator: ", ") }
    /// Gift certificates this sale issued.
    var certificateItems: [SaleItem] { items.filter(\.isCertificate) }
    /// Bonuses credited for this sale (0 when none or from a server without loyalty).
    var earnedBonuses: Int { max(0, bonusEarned ?? 0) }
}

/// One line of a refund: which sale line, how many units and what they returned.
nonisolated struct SaleRefundItem: Codable, Hashable, Sendable {
    let saleItemId: Int
    let name: String
    let quantity: Int
    let amount: Int
}

/// A refund of some lines or units of a sale, or of everything left (docs/API.md «SaleRefund»).
nonisolated struct SaleRefund: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let saleId: Int
    let items: [SaleRefundItem]
    let amount: Int
    /// How `amount` went back, by how the sale was paid.
    let payments: Payments
    /// Bonuses the sale earned that this refund took back.
    let bonusTakenBack: Int
    let restock: Bool
    let reason: String
    let employee: EmployeeRef?
    let shiftId: Int?
    let createdAt: Date
}

/// `POST /sales/:id/refund/preview`: what a refund would return, recorded exactly so by the refund.
nonisolated struct RefundPreview: Codable, Hashable, Sendable {
    let amount: Int
    let items: [SaleRefundItem]
    let payments: Payments
    let bonusTakenBack: Int
    /// The refund returns cash and no shift is open: open one first.
    let needsShift: Bool
}
