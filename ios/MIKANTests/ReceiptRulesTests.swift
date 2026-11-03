import Foundation
import Testing
@testable import MIKAN

/// The one-screen receipt: whose prices services take, what the big button does, the receipt in Telegram after the
/// sale and the short texts of lines, discounts and the shift strip.
@MainActor
struct ReceiptRulesTests {
    private static func employee(id: Int, isMaster: Bool) -> Employee {
        Employee(
            id: id, name: "Анна", login: "anna", phone: nil, color: nil, isMaster: isMaster, role: .master, active: true,
            createdAt: Fixtures.referenceDate
        )
    }

    private static func sale(client: ClientRef?, sentAt: Date? = nil) -> Sale {
        var sale = Sale(
            id: 9, number: 17, client: client, employee: EmployeeRef(id: 2, name: "Анна", color: nil), appointmentId: nil,
            shiftId: 3, items: [], subtotal: 3_500, discount: 0, total: 3_500,
            payments: Payments(cash: 3_500, card: 0, transfer: 0, deposit: 0),
            status: .completed, note: nil, refundedAt: nil, refundReason: nil, createdAt: Fixtures.referenceDate
        )
        sale.receiptSentAt = sentAt
        return sale
    }

    private static let linked = ClientRef(id: 1, name: "Иван", phone: nil, telegramLinked: true)
    private static let unlinked = ClientRef(id: 2, name: "Мария", phone: nil, telegramLinked: false)

    // MARK: Prices

    @Test("Services take the visit master's prices, else those of who opened the receipt when a master, else the catalog's")
    func pricingMaster() {
        let masters: Set<Int> = [2, 4]
        #expect(ReceiptPricing.masterId(appointmentMasterId: 4, openedBy: 2, masterIds: masters) == 4)
        #expect(ReceiptPricing.masterId(appointmentMasterId: nil, openedBy: 2, masterIds: masters) == 2)
        #expect(ReceiptPricing.masterId(appointmentMasterId: nil, openedBy: 7, masterIds: masters) == nil, "an admin opened it")
        #expect(ReceiptPricing.masterId(appointmentMasterId: nil, openedBy: nil, masterIds: masters) == nil)
    }

    @Test("Masters are the staff marked so, inactive ones too, and the signed-in master before the staff loads")
    func masterIds() {
        var retired = Self.employee(id: 5, isMaster: true)
        retired.active = false
        let staff = [Self.employee(id: 2, isMaster: true), Self.employee(id: 3, isMaster: false), retired]
        #expect(ReceiptPricing.masterIds(employees: staff, signedIn: nil) == [2, 5])
        #expect(ReceiptPricing.masterIds(employees: [], signedIn: Self.employee(id: 9, isMaster: true)) == [9])
        #expect(ReceiptPricing.masterIds(employees: [], signedIn: Self.employee(id: 9, isMaster: false)).isEmpty)
    }

    @Test("The cart keeps who opened the receipt and forgets it when cleared")
    func cartKeepsOpener() throws {
        let cart = CartStore(defaults: try #require(UserDefaults(suiteName: "ReceiptRulesTests")))
        let opener = EmployeeRef(id: 2, name: "Анна", color: nil)
        cart.load(OpenReceipt(
            id: 7, appointment: nil, client: nil, items: [], subtotal: 0, discount: 0, total: 0, itemCount: 0, note: nil,
            openedBy: opener, createdAt: Fixtures.referenceDate, updatedAt: Fixtures.referenceDate
        ))
        #expect(cart.openedBy == opener)
        cart.clear()
        #expect(cart.openedBy == nil)
    }

    // MARK: The big button

    @Test("No open shift turns the button into «Открыть смену»; a QR share shows the code first")
    func submitAction() {
        #expect(ReceiptSubmitAction.of(shiftIsOpen: false, qrShare: 0, amountDue: 3_500) == .openShift)
        #expect(ReceiptSubmitAction.of(shiftIsOpen: true, qrShare: 0, amountDue: 3_500) == .sell(amount: 3_500))
        #expect(ReceiptSubmitAction.of(shiftIsOpen: nil, qrShare: 0, amountDue: 3_500) == .sell(amount: 3_500), "unknown: the server decides")
        #expect(ReceiptSubmitAction.of(shiftIsOpen: true, qrShare: 2_000, amountDue: 3_500) == .showQr(amount: 2_000))

        #expect(ReceiptSubmitAction.openShift.title == "Открыть смену")
        #expect(ReceiptSubmitAction.sell(amount: 3_500).title == "Провести · \(Money.format(3_500))")
        #expect(ReceiptSubmitAction.sell(amount: 0).title == "Провести продажу", "paid by the prepayment")
        #expect(ReceiptSubmitAction.showQr(amount: 2_000).title == "Показать QR-код · \(Money.format(2_000))")
    }

    // MARK: Receipt in Telegram

    @Test("The bot's receipt is waited for only for a client with Telegram while the studio sends receipts; without Telegram nothing is offered")
    func deliveryStart() {
        let sentAt = Fixtures.referenceDate
        #expect(SaleReceiptDelivery.initialState(Self.sale(client: nil), sendsReceipts: true) == .noClient)
        #expect(SaleReceiptDelivery.initialState(Self.sale(client: Self.linked), sendsReceipts: true) == .waiting)
        #expect(SaleReceiptDelivery.initialState(Self.sale(client: Self.linked), sendsReceipts: nil) == .waiting, "on by default")
        #expect(SaleReceiptDelivery.initialState(Self.sale(client: Self.linked), sendsReceipts: false) == .notSent)
        #expect(SaleReceiptDelivery.initialState(Self.sale(client: Self.unlinked), sendsReceipts: true) == .noTelegram)
        #expect(SaleReceiptDelivery.initialState(Self.sale(client: Self.linked, sentAt: sentAt), sendsReceipts: true) == .sent(sentAt))
    }

    @Test("Checks stop once the receipt is sent, or after the last one")
    func deliveryChecks() {
        let sentAt = Fixtures.referenceDate
        let pending = Self.sale(client: Self.linked)
        #expect(SaleReceiptDelivery.state(after: pending, checksDone: 1) == .waiting)
        #expect(SaleReceiptDelivery.state(after: pending, checksDone: SaleReceiptDelivery.maxChecks) == .notSent)
        #expect(SaleReceiptDelivery.state(after: Self.sale(client: Self.linked, sentAt: sentAt), checksDone: 1) == .sent(sentAt))
    }

    // MARK: Texts

    @Test("A line says «2 × 1 500 ₽» for several units and who a certificate is for; a bad certificate is flagged")
    func lineTexts() {
        var labret = CartLine(kind: .product(id: 1, variantId: 4, stock: 3), name: "Лабрет — 8 мм", sizeName: "8 мм", unitPrice: 1_500)
        #expect(ReceiptLineText.detail(labret) == nil)
        labret.quantity = 2
        #expect(ReceiptLineText.detail(labret) == "2 × \(Money.format(1_500))")
        #expect(ReceiptLineText.problem(labret) == nil)

        let gift = CartLine.certificate(amount: 5_000, recipientName: " Маше ")
        #expect(ReceiptLineText.detail(gift) == "Кому: Маше")
        #expect(ReceiptLineText.problem(gift) == nil)
        #expect(ReceiptLineText.problem(.certificate(amount: 100, recipientName: "")) == CertificateRules.amountHint)
    }

    @Test("Quick discounts are whole rubles of the lines they may cover")
    func discountPresets() {
        #expect(ReceiptDiscountText.percents == [5, 10, 15, 20])
        #expect(ReceiptDiscountText.amount(percent: 10, base: 3_550) == 355)
        #expect(ReceiptDiscountText.amount(percent: 15, base: 999) == 149, "rounded down")
        #expect(ReceiptDiscountText.amount(percent: 10, base: 0) == 0)
    }

    @Test("The open shift strip names who opened it and the sales so far")
    func shiftStrip() {
        func shift(sales: Int, revenue: Int) -> CashShift {
            CashShift(
                id: 3, openedAt: Fixtures.referenceDate, openedBy: EmployeeRef(id: 2, name: "Анна", color: nil),
                openingCash: 5_000, closedAt: nil, closedBy: nil, closingCash: nil, note: nil, expectedCash: 8_500,
                difference: nil,
                summary: ShiftSummary(
                    salesCount: sales, revenue: revenue, cash: revenue, card: 0, transfer: 0, refunds: 0, cashRefunds: 0,
                    cashIn: 0, cashOut: 0
                ),
                operations: []
            )
        }
        let opened = "с \(DateText.time(Fixtures.referenceDate)) · Анна"
        #expect(ShiftStripText.details(shift(sales: 3, revenue: 12_000)) == "\(opened) · 3 продажи на \(Money.format(12_000))")
        #expect(ShiftStripText.details(shift(sales: 0, revenue: 0)) == "\(opened) · продаж нет")
    }
}
