import Foundation

/// Gift certificates sold at the till (docs/API.md «Sales (POS)», «Gift certificates»).
nonisolated enum CertificateRules {
    static let minAmount = 500
    static let maxAmount = 100_000
    static let lineName = "Подарочный сертификат"
    /// `recipientName` is kept up to this many characters (`400` beyond).
    static let recipientNameLimit = 100
    /// Nominal chips of the sale sheet.
    static let suggestedAmounts = [1_000, 3_000, 5_000, 10_000]

    static func isValidAmount(_ amount: Int) -> Bool {
        (minAmount...maxAmount).contains(amount)
    }

    /// «Номинал от 500 до 100 000 ₽»
    static var amountHint: String {
        "Номинал от \(Money.format(minAmount)) до \(Money.format(maxAmount))"
    }

    /// «Действует 12 месяцев с покупки»; «Действует бессрочно» for `nil` months.
    static func validityText(months: Int?) -> String {
        guard let months else { return "Действует бессрочно" }
        return "Действует \(Plural.count(months, one: "месяц", few: "месяца", many: "месяцев")) с покупки"
    }
}

/// A gift certificate being spent at checkout: what the lookup found and how much of it this receipt should take.
nonisolated struct CertificateCharge: Hashable, Identifiable, Sendable {
    let certificateId: Int
    let code: String
    /// Balance when it was looked up (the server checks it again).
    let balance: Int
    var expiresAt: Date?
    var recipientName: String?
    /// Asked to spend; the receipt takes at most the balance and what is still unpaid.
    var amount: Int

    var id: String { code }

    init(certificate: GiftCertificate, amount: Int) {
        certificateId = certificate.id
        code = certificate.code
        balance = certificate.balance
        expiresAt = certificate.expiresAt
        recipientName = certificate.recipientName
        self.amount = amount
    }

    init(certificateId: Int, code: String, balance: Int, expiresAt: Date? = nil, recipientName: String? = nil, amount: Int) {
        self.certificateId = certificateId
        self.code = code
        self.balance = balance
        self.expiresAt = expiresAt
        self.recipientName = recipientName
        self.amount = amount
    }
}

/// The client's bonuses and the birthday discount as known to the cart (loaded at checkout for `clientId`).
nonisolated struct CartClientLoyalty: Equatable, Sendable {
    let clientId: Int
    let loyalty: ClientLoyalty
}

/// Bonuses and gift certificates applied to a receipt on top of the appointment's prepayment. The prepayment is
/// counted first, then bonuses, then certificates in the order they were added; the methods pay the rest.
nonisolated enum CheckoutCredits {
    /// The most bonuses a receipt may take: `floor(total × percent / 100)`, never above the balance (the server
    /// checks the same rule).
    static func maxBonus(total: Int, percent: Int, balance: Int) -> Int {
        guard total > 0, percent > 0, balance > 0 else { return 0 }
        return min(balance, total * min(percent, 100) / 100)
    }

    /// Bonuses actually applied: what was asked, within `limit` and what is left to pay.
    static func bonusApplied(requested: Int, limit: Int, available: Int) -> Int {
        max(0, min(requested, limit, available))
    }

    /// What each certificate pays, in order: at most its balance and what is still unpaid.
    static func certificateAmounts(_ charges: [CertificateCharge], available: Int) -> [Int] {
        var left = max(0, available)
        return charges.map { charge in
            let applied = max(0, min(charge.amount, charge.balance, left))
            left -= applied
            return applied
        }
    }

    /// A new certificate takes what is still unpaid, up to its balance.
    static func suggestedAmount(balance: Int, unpaid: Int) -> Int {
        max(0, min(balance, unpaid))
    }

    /// The birthday discount in rubles: `floor(base × percent / 100)` of the lines it applies to (a gift certificate
    /// sold in the receipt is not discounted).
    static func birthdayDiscount(base: Int, percent: Int) -> Int {
        guard base > 0, percent > 0 else { return 0 }
        return base * min(percent, 100) / 100
    }

    /// Bonuses the sale will earn: `floor(percent × base / 100)`, base = total − bonuses − certificates paid −
    /// certificates sold (the server computes the real number).
    static func expectedCashback(percent: Int, total: Int, bonus: Int, certificatePaid: Int, certificatesSold: Int) -> Int {
        let base = total - bonus - certificatePaid - certificatesSold
        guard percent > 0, base > 0 else { return 0 }
        return base * min(percent, 100) / 100
    }

    /// The payments of a sale: the methods, the applied prepayment, bonuses and the certificates that pay something.
    static func payments(split: PaymentSplit, deposit: Int, bonus: Int, charges: [CertificateCharge], amounts: [Int]) -> Payments {
        var payments = split.payments(deposit: deposit)
        payments.bonus = max(0, bonus)
        payments.certificates = zip(charges, amounts)
            .filter { $0.1 > 0 }
            .map { CertificatePayment(code: $0.0.code, amount: $0.1) }
        payments.certificate = payments.certificates.reduce(0) { $0 + $1.amount }
        return payments
    }
}

/// Texts of bonuses at checkout and on the receipt.
nonisolated enum BonusText {
    /// «1 200 бонусов»
    static func count(_ amount: Int) -> String {
        "\(Money.group(UInt(max(0, amount)))) \(Plural.word(amount, one: "бонус", few: "бонуса", many: "бонусов"))"
    }

    /// «+75 бонусов» after a sale.
    static func earned(_ amount: Int) -> String {
        "+" + count(amount)
    }

    /// «На счёте 1 200 бонусов · можно списать до 900 ₽ (30% чека)».
    static func available(balance: Int, limit: Int, percent: Int) -> String {
        let base = "На счёте \(count(balance))"
        guard balance > 0 else { return base }
        guard limit > 0 else { return "\(base) · сейчас списать нельзя" }
        return "\(base) · можно списать до \(Money.format(limit)) (\(percent)% чека)"
    }

    /// «500 бонусов сгорят 2 ноября»
    static func expiring(_ expiring: BonusExpiring) -> String {
        "\(count(expiring.amount)) \(Plural.word(expiring.amount, one: "сгорит", few: "сгорят", many: "сгорят")) \(DateText.dayMonth(expiring.at))"
    }
}

/// «Чек полностью оплачен предоплатой и бонусами» when nothing is left for the payment methods.
nonisolated enum CheckoutPaidText {
    static func fullyPaid(deposit: Int, bonus: Int, certificate: Int) -> String {
        let parts = [
            deposit > 0 ? "предоплатой" : nil,
            bonus > 0 ? "бонусами" : nil,
            certificate > 0 ? "сертификатом" : nil,
        ].compactMap { $0 }
        guard !parts.isEmpty else { return "Чек полностью оплачен" }
        return "Чек полностью оплачен " + parts.formatted(.list(type: .and).locale(.app))
    }
}
