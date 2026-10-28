import Foundation

/// Bonuses, gift certificates and the birthday discount of the cart (docs/API.md «Sales (POS)», «Loyalty bonuses»,
/// «Gift certificates»). The math lives in `CheckoutCredits`; the server checks every rule again.
extension CartStore {
    /// The receipt sells a gift certificate.
    var sellsCertificate: Bool { lines.contains(where: \.isCertificate) }

    /// A receipt that sells a certificate is paid with money only (the server answers `400` otherwise).
    var acceptsCredits: Bool { !sellsCertificate }

    /// The cart client's bonuses, once checkout has loaded them for this very client.
    var activeLoyalty: ClientLoyalty? {
        guard let clientLoyalty, clientLoyalty.clientId == client?.id else { return nil }
        return clientLoyalty.loyalty
    }

    /// Bonuses can pay part of this receipt: a client with loyalty on and money-only lines.
    var canSpendBonuses: Bool {
        acceptsCredits && activeLoyalty != nil && loyaltyRules?.loyaltyEnabled == true
    }

    var bonusBalance: Int { activeLoyalty?.bonusBalance ?? 0 }

    /// The most bonuses this receipt may take: the studio's share of the total, the balance and what is left after
    /// the prepayment.
    var bonusLimit: Int {
        guard canSpendBonuses, let rules = loyaltyRules else { return 0 }
        let rule = CheckoutCredits.maxBonus(total: total, percent: rules.maxPaymentPercent, balance: bonusBalance)
        return min(rule, amountAfterDeposit)
    }

    /// Bonuses paying this receipt.
    var bonusApplied: Int {
        CheckoutCredits.bonusApplied(requested: bonusRequested, limit: bonusLimit, available: amountAfterDeposit)
    }

    /// What each certificate in `certificateCharges` pays (0 for all of them in a receipt that sells a certificate).
    var certificateAmounts: [Int] {
        guard acceptsCredits else { return certificateCharges.map { _ in 0 } }
        return CheckoutCredits.certificateAmounts(certificateCharges, available: amountAfterDeposit - bonusApplied)
    }

    var certificatesApplied: Int { certificateAmounts.reduce(0, +) }

    /// Bonuses and certificates together.
    var creditsApplied: Int { bonusApplied + certificatesApplied }

    /// Bonuses this sale should earn for a client with loyalty on; 0 otherwise.
    var expectedCashback: Int {
        guard client != nil, let rules = loyaltyRules, rules.loyaltyEnabled else { return 0 }
        let sold = lines.filter(\.isCertificate).reduce(0) { $0 + $1.total }
        return CheckoutCredits.expectedCashback(
            percent: rules.cashbackPercent, total: total, bonus: bonusApplied,
            certificatePaid: certificatesApplied, certificatesSold: sold
        )
    }

    /// What a found certificate takes by default: what is still unpaid, up to its balance. Looking up a code
    /// already paying counts what it pays now as unpaid (it is replaced).
    func suggestedCertificateAmount(balance: Int, code: String? = nil) -> Int {
        let own = zip(certificateCharges, certificateAmounts).first { $0.0.code == code }?.1 ?? 0
        return CheckoutCredits.suggestedAmount(balance: balance, unpaid: amountDue + own)
    }

    /// «Списать N бонусов»: on asks for the whole balance, so the receipt always takes the most it may
    /// (`bonusLimit` follows the lines and the discount); off spends none.
    var spendsBonuses: Bool {
        get { bonusRequested > 0 }
        set { bonusRequested = newValue ? bonusBalance : 0 }
    }

    // MARK: Birthday discount

    /// The client's birthday discount offered at checkout, while today is inside their birthday window.
    var birthdayDiscount: BirthdayDiscount? {
        guard let discount = activeLoyalty?.birthdayDiscount, discount.percent > 0 else { return nil }
        return discount
    }

    /// Lines the discount applies to: everything but a gift certificate being sold (the server's rule too).
    var discountableSubtotal: Int { lines.filter { !$0.isCertificate }.reduce(0) { $0 + $1.total } }

    /// The birthday discount in rubles for the current lines.
    var birthdayDiscountAmount: Int {
        guard let birthdayDiscount else { return 0 }
        return CheckoutCredits.birthdayDiscount(base: discountableSubtotal, percent: birthdayDiscount.percent)
    }

    var isBirthdayDiscountApplied: Bool { birthdayDiscountAmount > 0 && discount == birthdayDiscountAmount }

    func applyBirthdayDiscount() {
        guard birthdayDiscountAmount > 0 else { return }
        discount = birthdayDiscountAmount
    }
}
