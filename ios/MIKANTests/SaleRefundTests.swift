import Foundation
import Testing
@testable import MIKAN

/// Partial refunds of a sale (`POST /sales/:id/refund` with `items`, `…/refund/preview`): what can be chosen, the
/// request, how the money goes back, and the texts of the sale screens and the sales search.
struct SaleRefundTests {
    private static let nbsp = "\u{00A0}"
    private static let anna = EmployeeRef(id: 1, name: "Анна", color: nil)

    /// Лабрет — 8 мм × 2, a service and a gift certificate.
    private static let labret = item(1, .product, name: "Лабрет — 8 мм", quantity: 2, price: 1_500, size: "8 мм")
    private static let piercing = item(2, .service, name: "Прокол мочки", quantity: 1, price: 2_500)
    private static let certificate = SaleItem(
        id: 3, type: .service, productId: nil, serviceId: nil, name: "Подарочный сертификат MIKAN-7K3Q-9F2D",
        quantity: 1, price: 3_000, total: 3_000, certificateId: 8, certificateCode: "MIKAN-7K3Q-9F2D"
    )

    private static func item(
        _ id: Int, _ type: SaleItemType, name: String, quantity: Int, price: Int, size: String? = nil, refunded: Int? = nil
    ) -> SaleItem {
        SaleItem(
            id: id, type: type, productId: type == .product ? 10 : nil, variantId: type == .product ? 40 : nil,
            variantName: size, serviceId: type == .service ? 3 : nil, name: name, quantity: quantity, price: price,
            total: quantity * price, refundedQuantity: refunded
        )
    }

    private static func sale(
        _ items: [SaleItem], status: SaleStatus = .completed, refundedTotal: Int? = 0, refunds: [SaleRefund]? = []
    ) -> Sale {
        let total = items.reduce(0) { $0 + $1.total }
        return Sale(
            id: 9, number: 17, client: nil, employee: anna, appointmentId: nil, shiftId: 3, items: items,
            subtotal: total, discount: 0, total: total, payments: Payments(cash: total, card: 0, transfer: 0),
            status: status, note: nil, refundedAt: nil, refundReason: nil, createdAt: Fixtures.referenceDate,
            refundedTotal: refundedTotal, refunds: refunds
        )
    }

    // MARK: - Selection

    @Test("Lines with units left are offered; nothing is chosen until the user picks")
    func refundableLines() {
        let returnedOne = Self.item(1, .product, name: "Лабрет — 8 мм", quantity: 2, price: 1_500, size: "8 мм", refunded: 1)
        let returnedAll = Self.item(2, .service, name: "Прокол мочки", quantity: 1, price: 2_500, refunded: 1)
        let selection = RefundSelection(sale: Self.sale([returnedOne, returnedAll, Self.certificate], refundedTotal: 4_000))

        #expect(selection.lines.map(\.id) == [1, 3], "the fully returned service is gone")
        #expect(selection.line(id: 1)?.refundable == 1)
        #expect(selection.line(id: 1)?.returned == 1)
        #expect(selection.isEmpty)
        #expect(selection.items.isEmpty)
        #expect(selection.body(reason: "Брак", restock: true) == nil, "nothing to return")
    }

    @Test("The only line left is chosen whole at once")
    func onlyLinePreselected() {
        let selection = RefundSelection(sale: Self.sale([Self.labret]))
        #expect(selection.quantity(of: 1) == 2)
        #expect(selection.isWhole)
    }

    @Test("A sale refunded on a server without partial refunds has nothing left")
    func olderRefundedSale() {
        let sale = Self.sale([Self.labret, Self.piercing], status: .refunded, refundedTotal: nil, refunds: nil)
        #expect(sale.returnedQuantity(of: Self.labret) == 2)
        #expect(RefundSelection(sale: sale).lines.isEmpty)
    }

    @Test("Choosing a line takes every unit left; the quantity stays within 1…what is left")
    func toggleAndQuantity() {
        var selection = RefundSelection(sale: Self.sale([Self.labret, Self.piercing]))
        selection = selection.toggling(1)
        #expect(selection.quantity(of: 1) == 2)
        selection = selection.settingQuantity(5, of: 1)
        #expect(selection.quantity(of: 1) == 2)
        selection = selection.settingQuantity(0, of: 1)
        #expect(selection.quantity(of: 1) == 1)
        #expect(!selection.isWhole)
        #expect(selection.items == [RefundItemBody(saleItemId: 1, quantity: 1)])
        #expect(selection.toggling(1).isEmpty, "a second tap drops the line")
        #expect(selection.settingQuantity(1, of: 99) == selection, "an unknown line changes nothing")
    }

    @Test("«Вернуть весь чек» chooses every unit left, in the sale's order")
    func selectAll() {
        let selection = RefundSelection(sale: Self.sale([Self.labret, Self.piercing, Self.certificate])).selectingAll()
        #expect(selection.isWhole)
        #expect(selection.units == 4)
        #expect(selection.items == [
            RefundItemBody(saleItemId: 1, quantity: 2),
            RefundItemBody(saleItemId: 2, quantity: 1),
            RefundItemBody(saleItemId: 3, quantity: 1),
        ])
        #expect(selection.hasCertificates)
    }

    @Test("Restock goes only with product lines; the reason is required and trimmed")
    func requestBody() throws {
        let base = RefundSelection(sale: Self.sale([Self.labret, Self.piercing]))
        let service = base.toggling(2)
        #expect(!service.hasProducts)
        #expect(service.body(reason: "  Передумал(а) ", restock: true)?.restock == false)
        #expect(service.body(reason: "  Передумал(а) ", restock: true)?.reason == "Передумал(а)")
        #expect(service.body(reason: "   ", restock: true) == nil)
        #expect(service.body(reason: String(repeating: "а", count: 501), restock: true) == nil)

        let product = try #require(base.toggling(1).settingQuantity(1, of: 1).body(reason: "Брак", restock: true))
        #expect(product.restock)
        #expect(product.items == [RefundItemBody(saleItemId: 1, quantity: 1)])
        #expect(base.toggling(1).body(reason: "Брак", restock: false)?.restock == false)
    }

    @Test("The reason field explains only a too long reason")
    func reasonIssue() {
        #expect(RefundReason.issue("Брак") == nil)
        #expect(RefundReason.issue(String(repeating: "а", count: 501)) == "Причина — не длиннее 500 символов.")
        #expect(RefundReason.quick == ["Не подошёл размер", "Брак", "Передумал(а)"])
    }

    // MARK: - How the money goes back

    @Test("Every part of the refund reads as what staff do, zero parts are left out")
    func outcomeLines() {
        let payments = Payments(cash: 1_350, card: 0, transfer: 500, qr: 700, deposit: 2_000, bonus: 300, certificate: 400)
        let lines = RefundOutcome.lines(payments: payments, bonusTakenBack: 67)
        #expect(lines.map(\.instruction) == [
            "Наличными из кассы",
            "Переводом — верните клиенту сами",
            "По QR — верните в интернет-банке Точки",
            "Предоплата вернётся в запись",
            "Бонусы вернутся клиенту",
            "Сертификат пополнится",
            "Спишем начисленные бонусы",
        ])
        #expect(lines.map(\.value) == [
            "1\(Self.nbsp)350\(Self.nbsp)₽", "500\(Self.nbsp)₽", "700\(Self.nbsp)₽", "2\(Self.nbsp)000\(Self.nbsp)₽",
            "+300", "400\(Self.nbsp)₽", "−67",
        ])
        #expect(lines.filter(\.isPaidOut).map(\.kind) == [.cash, .transfer, .qr])
        #expect(RefundOutcome.lines(payments: Payments(cash: 0, card: 0, transfer: 0), bonusTakenBack: 0).isEmpty)
    }

    @Test("A partial refund does not say the sale is refunded")
    func partialConfirmation() {
        let payments = Payments(cash: 1_350, card: 0, transfer: 0)
        #expect(SaleRefundText.confirmButton(payments) == "Вернуть 1\(Self.nbsp)350\(Self.nbsp)₽")
        #expect(
            SaleRefundText.confirmationMessage(payments, isWhole: false)
                == "Возврат по части чека нельзя отменить. Выдайте клиенту 1\(Self.nbsp)350\(Self.nbsp)₽ наличными из кассы."
        )
        #expect(SaleRefundText.confirmationTitle(isWhole: true) == "Вернуть весь чек?")
        #expect(SaleRefundText.confirmationTitle(isWhole: false) == "Вернуть выбранное?")
    }

    @Test("The restock note names the chosen units of each size")
    func restockNoteForChosenUnits() {
        #expect(
            SaleRefundText.restockNote([(item: Self.labret, quantity: 1), (item: Self.piercing, quantity: 1)])
                == "Украшения вернутся на склад в проданные размеры: Лабрет — 8 мм. " + SaleRefundText.restockHint
        )
    }

    // MARK: - Sale screens

    @Test("Returned units of a line: «вернули 1 из 2», «вернули» for the only unit")
    func returnedUnits() {
        #expect(SaleRefundText.returnedUnits(0, of: 2) == nil)
        #expect(SaleRefundText.returnedUnits(1, of: 2) == "вернули 1 из 2")
        #expect(SaleRefundText.returnedUnits(2, of: 2) == "вернули 2 из 2")
        #expect(SaleRefundText.returnedUnits(1, of: 1) == "вернули")
    }

    @Test("A refund reads when, who and what")
    func refundTexts() {
        let refund = SaleRefund(
            id: 3, saleId: 9, items: [SaleRefundItem(saleItemId: 1, name: "Лабрет — 8 мм", quantity: 2, amount: 2_700)],
            amount: 2_700, payments: Payments(cash: 2_700, card: 0, transfer: 0), bonusTakenBack: 0, restock: true,
            reason: "Брак", employee: Self.anna, shiftId: 5, createdAt: Fixtures.referenceDate
        )
        #expect(SaleRefundText.itemLine(refund.items[0]) == "Лабрет — 8 мм × 2")
        #expect(SaleRefundText.refundSubtitle(refund) == "\(DateText.dateTime(Fixtures.referenceDate)) · Анна")
        #expect(RefundOutcome.lines(refund).map(\.recordedTitle) == ["Наличными из кассы"])
    }

    @Test("Partly refunded: some money returned, the sale still completed")
    func partlyRefunded() {
        let sale = Self.sale([Self.labret], refundedTotal: 1_350)
        #expect(sale.isPartlyRefunded)
        #expect(sale.returnedAmount == 1_350)
        #expect(!Self.sale([Self.labret]).isPartlyRefunded)
        #expect(!Self.sale([Self.labret], status: .refunded, refundedTotal: 3_000).isPartlyRefunded)
    }

    @Test("The receipt row names the time today and the date before")
    func receiptSentText() {
        let sentAt = Fixtures.referenceDate
        #expect(SaleReceiptText.sent(at: sentAt, now: sentAt.addingTimeInterval(60)) == "Чек отправлен в Telegram · \(DateText.time(sentAt))")
        #expect(
            SaleReceiptText.sent(at: sentAt, now: sentAt.addingTimeInterval(3 * 86_400))
                == "Чек отправлен в Telegram · \(DateText.dateTime(sentAt))"
        )
    }

    // MARK: - Sales history

    @Test("The search sends the trimmed text within the server's limit, nothing when blank")
    func searchQuery() {
        #expect(SaleSearch.query("  №17 ") == "№17")
        #expect(SaleSearch.query("   ") == nil)
        #expect(SaleSearch.query(String(repeating: "7", count: 150))?.count == 100)
    }

    @Test("The day total counts what the studio kept")
    func keptTotal() {
        let kept = Self.sale([Self.labret], refundedTotal: 1_350)
        let refunded = Self.sale([Self.piercing], status: .refunded, refundedTotal: 2_500)
        let olderRefunded = Self.sale([Self.piercing], status: .refunded, refundedTotal: nil, refunds: nil)
        #expect(SalesHistoryText.keptTotal([kept, refunded, olderRefunded, Self.sale([Self.piercing])]) == 1_650 + 2_500)
    }
}
