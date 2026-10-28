import Foundation
import Testing
@testable import MIKAN

/// Paying with bonuses and gift certificates at checkout (docs/API.md «Sales (POS)», «Loyalty bonuses»):
/// the max-bonus rule, the order the credits apply in, the payments that go out and the cart around them.
@MainActor
struct CheckoutCreditsTests {
    private static let ivan = ClientRef(id: 1, name: "Иван", lastName: "Петров", phone: nil, telegramLinked: true)
    private static let rules = CheckoutLoyaltyRules(loyaltyEnabled: true, cashbackPercent: 5, maxPaymentPercent: 30)

    private func makeCart() throws -> CartStore {
        let defaults = try #require(UserDefaults(suiteName: "CheckoutCreditsTests"))
        defaults.removeObject(forKey: CartStore.lastPaymentMethodKey)
        return CartStore(defaults: defaults)
    }

    /// A 5 000 ₽ receipt of Иван, who has `balance` bonuses, in a studio where bonuses pay up to 30%.
    private func loyalCart(balance: Int = 2_000, birthday: BirthdayDiscount? = nil) throws -> CartStore {
        let cart = try makeCart()
        cart.addCustomService(name: "Хеликс", price: 5_000)
        cart.client = Self.ivan
        cart.setLoyaltyRules(Self.rules)
        cart.setClientLoyalty(ClientLoyalty(bonusBalance: balance, birthdayDiscount: birthday), for: Self.ivan.id)
        return cart
    }

    private static func charge(_ code: String, balance: Int, amount: Int) -> CertificateCharge {
        CertificateCharge(certificateId: 1, code: code, balance: balance, amount: amount)
    }

    // MARK: Max-bonus rule

    @Test("Bonuses pay at most the studio's share of the total, never more than the balance", arguments: [
        (5_000, 30, 2_000, 1_500),
        (5_000, 30, 1_200, 1_200),
        (999, 30, 5_000, 299),
        (5_000, 0, 2_000, 0),
        (5_000, 100, 2_000, 2_000),
        (5_000, 150, 9_000, 5_000),
        (0, 30, 2_000, 0),
        (5_000, 30, 0, 0),
    ])
    func maxBonus(total: Int, percent: Int, balance: Int, expected: Int) {
        #expect(CheckoutCredits.maxBonus(total: total, percent: percent, balance: balance) == expected)
    }

    @Test("Applied bonuses stay within the limit and what is left to pay")
    func bonusApplied() {
        #expect(CheckoutCredits.bonusApplied(requested: 2_000, limit: 1_500, available: 5_000) == 1_500)
        #expect(CheckoutCredits.bonusApplied(requested: 2_000, limit: 1_500, available: 800) == 800)
        #expect(CheckoutCredits.bonusApplied(requested: 300, limit: 1_500, available: 5_000) == 300)
        #expect(CheckoutCredits.bonusApplied(requested: -5, limit: 1_500, available: 5_000) == 0)
    }

    @Test("Certificates pay in order, each up to its balance and what is still unpaid")
    func certificateAmounts() {
        let charges = [
            Self.charge("MIKAN-AAAA-1111", balance: 1_000, amount: 1_000),
            Self.charge("MIKAN-BBBB-2222", balance: 5_000, amount: 5_000),
            Self.charge("MIKAN-CCCC-3333", balance: 700, amount: 900),
        ]
        #expect(CheckoutCredits.certificateAmounts(charges, available: 3_000) == [1_000, 2_000, 0])
        #expect(CheckoutCredits.certificateAmounts(charges, available: 10_000) == [1_000, 5_000, 700])
        #expect(CheckoutCredits.certificateAmounts(charges, available: 0) == [0, 0, 0])
    }

    // MARK: Payments math in the cart

    @Test("Prepayment, then bonuses, then certificates; the method pays the rest and everything sums to the total")
    func paymentsSumToTotal() throws {
        let cart = try makeCart()
        cart.prefill(from: Self.appointment(price: 5_000, deposit: 1_000))
        cart.setLoyaltyRules(Self.rules)
        cart.setClientLoyalty(ClientLoyalty(bonusBalance: 2_000), for: Self.ivan.id)
        cart.bonusRequested = 5_000
        cart.addCertificateCharge(Self.certificate("MIKAN-7K3Q-9F2D", balance: 2_000), amount: 2_000)

        #expect(cart.amountAfterDeposit == 4_000)
        #expect(cart.bonusLimit == 1_500, "30% of 5 000")
        #expect(cart.bonusApplied == 1_500)
        #expect(cart.certificatesApplied == 2_000)
        #expect(cart.amountDue == 500)

        let payments = cart.payments
        #expect(payments.cash == 500)
        #expect(payments.deposit == 1_000)
        #expect(payments.bonus == 1_500)
        #expect(payments.certificate == 2_000)
        #expect(payments.certificates == [CertificatePayment(code: "MIKAN-7K3Q-9F2D", amount: 2_000)])
        #expect(payments.total == cart.total)
        #expect(cart.canSubmit)
    }

    @Test("Credits covering everything leave nothing for the methods, and the sale can go")
    func paidInFullByCredits() throws {
        let cart = try loyalCart()
        cart.spendsBonuses = true
        cart.addCertificateCharge(Self.certificate("MIKAN-7K3Q-9F2D", balance: 10_000), amount: 10_000)

        #expect(cart.bonusApplied == 1_500)
        #expect(cart.certificatesApplied == 3_500, "only what is left after the bonuses")
        #expect(cart.amountDue == 0)
        #expect(cart.isPaidInFull)
        #expect(!cart.isPaidByDeposit)
        #expect(cart.split == PaymentSplit())
        #expect(cart.payments.total == 5_000)
        #expect(cart.canSubmit)
        #expect(CheckoutPaidText.fullyPaid(deposit: 0, bonus: 1_500, certificate: 3_500) == "Чек полностью оплачен бонусами и сертификатом")
    }

    @Test("«Списать N бонусов» takes the most the receipt allows, follows the lines and spends none when off")
    func bonusToggle() throws {
        let cart = try loyalCart()
        #expect(!cart.spendsBonuses)

        cart.spendsBonuses = true
        #expect(cart.spendsBonuses)
        #expect(cart.bonusApplied == 1_500, "30% of 5 000, below the 2 000 balance")

        cart.addCustomService(name: "Мочка", price: 1_000)
        #expect(cart.bonusApplied == 1_800, "the limit grows with the receipt")
        cart.discount = 6_000
        #expect(cart.bonusApplied == 0, "nothing is left to pay")

        cart.spendsBonuses = false
        cart.discount = 0
        #expect(cart.bonusRequested == 0)
        #expect(cart.bonusApplied == 0)
    }

    @Test("A manual split must cover only what is left after the credits")
    func splitCoversRemainder() throws {
        let cart = try loyalCart()
        cart.bonusRequested = 1_000
        cart.selectPaymentMode(.split)
        cart.manualSplit = PaymentSplit(cash: 2_000, transfer: 2_000)

        #expect(cart.remaining == 0)
        #expect(cart.canSubmit)
        cart.manualSplit.transfer = 3_000
        #expect(cart.remaining == -1_000)
        #expect(!cart.canSubmit)
    }

    @Test("Bonuses need the very client they were loaded for, with loyalty on")
    func bonusesFollowTheClient() throws {
        let cart = try loyalCart()
        cart.bonusRequested = 1_000
        #expect(cart.bonusApplied == 1_000)

        cart.client = ClientRef(id: 2, name: "Мария", phone: nil, telegramLinked: false)
        #expect(cart.bonusApplied == 0, "another client's balance is unknown")
        cart.setClientLoyalty(ClientLoyalty(bonusBalance: 5_000), for: 2)
        #expect(cart.bonusRequested == 0, "bonuses asked for Иван are not spent from Мария")

        cart.bonusRequested = 500
        cart.setLoyaltyRules(CheckoutLoyaltyRules(loyaltyEnabled: false, maxPaymentPercent: 30))
        #expect(!cart.canSpendBonuses)
        #expect(cart.bonusApplied == 0)
    }

    @Test("A receipt that sells a certificate is paid with money only")
    func certificateSaleTakesNoCredits() throws {
        let cart = try loyalCart()
        cart.bonusRequested = 1_000
        cart.addCertificateCharge(Self.certificate("MIKAN-7K3Q-9F2D", balance: 2_000), amount: 2_000)
        cart.addCertificate(amount: 3_000, recipientName: "Маше")

        #expect(cart.sellsCertificate)
        #expect(!cart.acceptsCredits)
        #expect(cart.bonusApplied == 0)
        #expect(cart.certificateAmounts == [0])
        #expect(cart.amountDue == 8_000)
        let payments = cart.payments
        #expect(payments.bonus == 0 && payments.certificates.isEmpty)
        #expect(cart.expectedCashback == 250, "5% of the 5 000 ₽ service; the certificate earns nothing")
    }

    @Test("Certificate lines: nominal 500…100 000 and quantity 1")
    func certificateLineValidity() {
        #expect(CartLine.certificate(amount: 500, recipientName: "").isValid)
        #expect(CartLine.certificate(amount: 100_000, recipientName: "").isValid)
        #expect(!CartLine.certificate(amount: 499, recipientName: "").isValid)
        #expect(!CartLine.certificate(amount: 100_001, recipientName: "").isValid)
        var twice = CartLine.certificate(amount: 5_000, recipientName: "")
        twice.quantity = 2
        #expect(!twice.isValid)
    }

    @Test("The open receipt keeps a certificate to sell; the discount never covers it")
    func receiptBodyKeepsCertificates() throws {
        let cart = try makeCart()
        cart.addCustomService(name: "Хеликс", price: 3_000)
        cart.addCertificate(amount: 5_000, recipientName: "Маше")
        cart.discount = 4_000

        let body = cart.makeReceiptBody()
        #expect(body.items?.map(\.type) == [.service, .certificate])
        #expect(body.items?.last?.recipientName == "Маше")
        #expect(body.items?.last?.price == 5_000)
        #expect(body.discount == 3_000, "capped to the lines it may cover")
        #expect(!cart.isDiscountValid)
        #expect(!cart.canSubmit)

        cart.discount = 3_000
        #expect(cart.isDiscountValid)
        #expect(cart.makeSaleBody().items.map(\.type) == [.service, .certificate])
    }

    @Test("A certificate line saved in the receipt comes back with its recipient and note")
    func receiptRestoresCertificate() throws {
        let cart = try makeCart()
        let certificateLine = OpenReceiptItem(
            type: .service, name: CertificateRules.lineName, quantity: 1, price: 5_000, total: 5_000,
            certificate: OpenReceiptCertificate(recipientName: "Маше", note: "Упаковать")
        )
        cart.load(Self.receipt(id: 7, extra: [certificateLine]))

        #expect(cart.lines.map(\.isCertificate) == [false, true])
        let line = try #require(cart.lines.last)
        #expect(line.unitPrice == 5_000)
        #expect(line.recipientName == "Маше")
        let saved = try #require(cart.makeReceiptBody().items?.last)
        #expect(saved == SaleItemBody(
            type: .certificate, productId: nil, serviceId: nil, name: nil, quantity: 1, price: 5_000,
            recipientName: "Маше", note: "Упаковать"
        ))
    }

    @Test("Reloading the same receipt keeps the bonuses and certificates chosen to pay; another receipt drops them")
    func reloadKeepsCredits() throws {
        let cart = try loyalCart()
        let receipt = Self.receipt(id: 7)
        cart.load(receipt)
        cart.client = Self.ivan
        cart.setClientLoyalty(ClientLoyalty(bonusBalance: 2_000), for: Self.ivan.id)
        cart.bonusRequested = 300
        cart.addCertificateCharge(Self.certificate("MIKAN-7K3Q-9F2D", balance: 2_000), amount: 1_000)

        cart.load(receipt)
        #expect(cart.bonusRequested == 300)
        #expect(cart.certificateCharges.map(\.code) == ["MIKAN-7K3Q-9F2D"])

        cart.load(Self.receipt(id: 8))
        #expect(cart.bonusRequested == 0)
        #expect(cart.certificateCharges.isEmpty)
        #expect(cart.activeLoyalty == nil)
    }

    @Test("Clearing the cart forgets bonuses, certificates and the client's loyalty but keeps the studio's rules")
    func clearForgetsCredits() throws {
        let cart = try loyalCart()
        cart.bonusRequested = 500
        cart.addCertificateCharge(Self.certificate("MIKAN-7K3Q-9F2D", balance: 2_000), amount: 1_000)

        cart.clear()
        #expect(cart.bonusRequested == 0)
        #expect(cart.certificateCharges.isEmpty)
        #expect(cart.clientLoyalty == nil)
        #expect(cart.loyaltyRules == Self.rules)
    }

    @Test("A certificate pays at most its balance; the same code looked up again replaces it")
    func certificateCharges() throws {
        let cart = try loyalCart()
        let certificate = Self.certificate("MIKAN-7K3Q-9F2D", balance: 2_000)
        cart.addCertificateCharge(certificate, amount: 9_000)
        #expect(cart.certificateCharges.map(\.amount) == [9_000], "what was asked is kept")
        #expect(cart.certificateAmounts == [2_000], "only the balance is spent")

        #expect(cart.suggestedCertificateAmount(balance: 2_000, code: certificate.code) == 2_000)
        cart.addCertificateCharge(certificate, amount: 500)
        #expect(cart.certificateCharges.count == 1)
        #expect(cart.certificatesApplied == 500)

        cart.removeCertificateCharge(code: certificate.code)
        #expect(cart.certificateCharges.isEmpty)
    }

    // MARK: Birthday discount and cashback

    @Test("The birthday discount is the percent of everything but a certificate being sold")
    func birthdayDiscount() throws {
        let cart = try loyalCart(birthday: BirthdayDiscount(percent: 10, until: "2026-10-26"))
        cart.addCertificate(amount: 3_000, recipientName: "")

        #expect(cart.birthdayDiscountAmount == 500)
        #expect(!cart.isBirthdayDiscountApplied)
        cart.applyBirthdayDiscount()
        #expect(cart.discount == 500)
        #expect(cart.isBirthdayDiscountApplied)

        let other = try loyalCart(birthday: nil)
        #expect(other.birthdayDiscount == nil)
        #expect(other.birthdayDiscountAmount == 0)
        #expect(CheckoutCredits.birthdayDiscount(base: 1_999, percent: 10) == 199)
    }

    @Test("Cashback is counted on the money part only")
    func expectedCashback() {
        #expect(CheckoutCredits.expectedCashback(percent: 5, total: 5_000, bonus: 1_000, certificatePaid: 2_000, certificatesSold: 0) == 100)
        #expect(CheckoutCredits.expectedCashback(percent: 5, total: 5_000, bonus: 0, certificatePaid: 0, certificatesSold: 5_000) == 0)
        #expect(CheckoutCredits.expectedCashback(percent: 0, total: 5_000, bonus: 0, certificatePaid: 0, certificatesSold: 0) == 0)
    }

    @Test("Bonus texts")
    func bonusTexts() {
        #expect(BonusText.count(1) == "1 бонус")
        #expect(BonusText.count(3) == "3 бонуса")
        #expect(BonusText.count(1_200) == "1\u{00A0}200 бонусов")
        #expect(BonusText.earned(75) == "+75 бонусов")
        #expect(BonusText.available(balance: 1_200, limit: 900, percent: 30)
            == "На счёте 1\u{00A0}200 бонусов · можно списать до 900\u{00A0}₽ (30% чека)")
        #expect(BonusText.available(balance: 0, limit: 0, percent: 30) == "На счёте 0 бонусов")
    }

    // MARK: Helpers

    private static func certificate(_ code: String, balance: Int) -> GiftCertificate {
        GiftCertificate(
            id: 11, code: code, amount: balance, balance: balance, status: .active, expiresAt: nil, buyer: nil,
            recipientName: nil, note: nil, saleId: nil, saleNumber: nil, createdAt: Fixtures.referenceDate
        )
    }

    private static func appointment(price: Int, deposit: Int) -> Appointment {
        Appointment(
            id: 4, client: ivan, master: EmployeeRef(id: 2, name: "Анна", color: nil), service: nil, title: "Хеликс",
            startsAt: Fixtures.referenceDate, endsAt: Fixtures.referenceDate.addingTimeInterval(3_600),
            status: .completed, price: price, deposit: deposit, notes: nil, saleId: nil, completedAt: nil,
            createdAt: Fixtures.referenceDate, updatedAt: Fixtures.referenceDate
        )
    }

    private static func receipt(id: Int, extra: [OpenReceiptItem] = []) -> OpenReceipt {
        let line = OpenReceiptItem(type: .service, serviceId: 3, name: "Хеликс", quantity: 1, price: 5_000, total: 5_000)
        let items = [line] + extra
        let subtotal = items.reduce(0) { $0 + $1.total }
        return OpenReceipt(
            id: id, appointment: nil, client: ivan, items: items, subtotal: subtotal, discount: 0, total: subtotal,
            itemCount: items.count, note: nil, openedBy: nil, createdAt: Fixtures.referenceDate,
            updatedAt: Fixtures.referenceDate
        )
    }
}
