import Foundation
import Testing
@testable import MIKAN

/// Loyalty and gift certificates on the wire (docs/API.md «Client», «Sale», «Sales (POS)», «Loyalty bonuses»,
/// «Gift certificates»): new fields decode, older servers that omit them still work, unknown values are tolerated.
@MainActor
struct LoyaltyDecodingTests {
    /// A sale from a server with loyalty: bonuses and a certificate paid part, and a certificate was sold.
    private static let loyaltySale = #"""
    { "id": 5, "number": 30, "client": \#(Fixtures.clientRef), "employee": \#(Fixtures.employeeRef),
      "appointmentId": null, "shiftId": 3,
      "items": [ { "id": 1, "type": "service", "productId": null, "variantId": null, "variantName": null,
                   "serviceId": 3, "name": "Прокол мочки", "quantity": 1, "price": 3000, "total": 3000,
                   "certificateId": null },
                 { "id": 2, "type": "service", "productId": null, "variantId": null, "variantName": null,
                   "serviceId": null, "name": "Подарочный сертификат MIKAN-7K3Q-9F2D", "quantity": 1,
                   "price": 5000, "total": 5000, "certificateId": 11, "certificateCode": "MIKAN-7K3Q-9F2D" } ],
      "subtotal": 8000, "discount": 0, "total": 8000,
      "payments": { "cash": 6000, "card": 0, "transfer": 0, "qr": 0, "deposit": 0, "bonus": 500, "certificate": 1500 },
      "bonusEarned": 75,
      "status": "completed", "note": null, "refundedAt": null, "refundReason": null, "createdAt": "<T>" }
    """#

    @Test("An older sale without bonus, certificate or bonusEarned keys reads as zero", arguments: [true, false])
    func olderSale(fractional: Bool) throws {
        let sale = try Fixtures.decode(Sale.self, Fixtures.sale, fractional: fractional)

        #expect(sale.payments.bonus == 0)
        #expect(sale.payments.certificate == 0)
        #expect(sale.payments.certificates.isEmpty)
        #expect(sale.bonusEarned == nil)
        #expect(sale.earnedBonuses == 0)
        #expect(sale.certificateItems.isEmpty)
        #expect(sale.payments.paymentLines.map(\.source) == [.method(.cash)])
    }

    @Test("A loyalty sale reads its bonuses, certificate payment and the certificate it sold")
    func loyaltySale() throws {
        let sale = try Fixtures.decode(Sale.self, Self.loyaltySale)

        #expect(sale.payments.bonus == 500)
        #expect(sale.payments.certificate == 1_500)
        #expect(sale.payments.total == sale.total)
        #expect(sale.payments.paidNow == 6_000)
        #expect(sale.earnedBonuses == 75)
        #expect(sale.items.map(\.isCertificate) == [false, true])
        #expect(sale.certificateItems.map(\.certificateId) == [11])
        #expect(sale.certificateItems.first?.issuedCertificateCode == "MIKAN-7K3Q-9F2D")
        #expect(!sale.hasProducts)
        #expect(sale.payments.paymentLines.map(\.source) == [.method(.cash), .bonus, .certificate])
        #expect(PaymentText.methods(sale.payments) == "наличными, бонусами и сертификатом")
    }

    @Test("An unknown item type keeps the sale readable", arguments: ["gift_card", "subscription"])
    func unknownItemType(type: String) throws {
        let json = Fixtures.sale.replacingOccurrences(of: #""type": "product""#, with: #""type": "\#(type)""#)
        let sale = try Fixtures.decode(Sale.self, json)

        #expect(sale.items.first?.type == .unknown)
        #expect(sale.items.first?.isCertificate == false)
        #expect(!sale.hasProducts)
    }

    @Test("A line typed certificate is a certificate even without certificateId")
    func certificateTypedLine() {
        let item = SaleItem(
            id: 1, type: .certificate, productId: nil, serviceId: nil, name: "Подарочный сертификат", quantity: 1,
            price: 3_000, total: 3_000
        )
        #expect(item.isCertificate)
        #expect(item.issuedCertificateCode == nil, "no code anywhere")
    }

    @Test("certificateCode wins; an older server's line only names the code, which is read from the name")
    func certificateCodeFallback() {
        let newer = SaleItem(
            id: 1, type: .service, productId: nil, serviceId: nil, name: "Подарочный сертификат", quantity: 1,
            price: 3_000, total: 3_000, certificateId: 11, certificateCode: "MIKAN-H4WP-2XRT"
        )
        let older = SaleItem(
            id: 2, type: .service, productId: nil, serviceId: nil, name: "Подарочный сертификат MIKAN-7K3Q-9F2D",
            quantity: 1, price: 3_000, total: 3_000, certificateId: 12
        )
        let service = SaleItem(
            id: 3, type: .service, productId: nil, serviceId: 3, name: "Прокол MIKAN-7K3Q-9F2D", quantity: 1,
            price: 3_000, total: 3_000
        )
        #expect(newer.issuedCertificateCode == "MIKAN-H4WP-2XRT")
        #expect(older.issuedCertificateCode == "MIKAN-7K3Q-9F2D")
        #expect(service.issuedCertificateCode == nil, "only certificate lines have a code")
    }

    @Test("An open receipt's certificate to sell decodes as a service line with `certificate`; others have none")
    func receiptCertificateLine() throws {
        let json = #"""
        { "id": 9, "appointment": null, "client": null, "note": null, "createdAt": "<T>",
          "items": [ { "type": "service", "productId": null, "variantId": null, "variantName": null,
                       "productKind": null, "serviceId": null, "name": "Подарочный сертификат", "quantity": 1,
                       "price": 5000, "total": 5000, "stock": null,
                       "certificate": { "recipientName": "Маше", "note": null } },
                     { "type": "service", "serviceId": 3, "name": "Хеликс", "quantity": 1, "price": 3000,
                       "certificate": null } ] }
        """#
        let receipt = try Fixtures.decode(OpenReceipt.self, json)

        #expect(receipt.items.map(\.certificate) == [OpenReceiptCertificate(recipientName: "Маше", note: nil), nil])
        let lines = receipt.items.compactMap(CartLine.init(item:))
        #expect(lines.map(\.isCertificate) == [true, false])
        #expect(lines.first?.recipientName == "Маше")
    }

    @Test("An open receipt line of an unknown type decodes and is left out of the cart")
    func unknownReceiptLine() throws {
        let json = #"""
        { "id": 9, "appointment": null, "client": null, "note": null, "createdAt": "<T>",
          "items": [ { "type": "membership", "name": "Абонемент", "quantity": 1, "price": 9000 },
                     { "type": "service", "serviceId": 3, "name": "Хеликс", "quantity": 1, "price": 3000 } ] }
        """#
        let receipt = try Fixtures.decode(OpenReceipt.self, json)

        #expect(receipt.items.map(\.type) == [.unknown, .service])
        #expect(receipt.items.compactMap(CartLine.init(item:)).map(\.name) == ["Хеликс"])
    }

    @Test("Client.loyalty: nil from an older server, filled from a new one")
    func clientLoyalty() throws {
        let older = try Fixtures.decode(Client.self, Fixtures.clientInList)
        #expect(older.loyalty == nil)

        let json = Fixtures.clientInList.replacingOccurrences(of: #""stats": null"#, with: #"""
        "stats": null, "marketingOptOut": false,
        "loyalty": { "bonusBalance": 1200, "expiring": { "amount": 500, "at": "<T>" },
                     "birthdayDiscount": { "percent": 10, "until": "2026-10-26" } }
        """#)
        let client = try Fixtures.decode(Client.self, json)
        let loyalty = try #require(client.loyalty)

        #expect(loyalty.bonusBalance == 1_200)
        #expect(loyalty.expiring == BonusExpiring(amount: 500, at: Fixtures.referenceDate))
        #expect(loyalty.birthdayDiscount == BirthdayDiscount(percent: 10, until: "2026-10-26"))
    }

    @Test("An unreadable part of loyalty reads as none instead of failing the card")
    func tolerantLoyalty() throws {
        let json = #"{ "bonusBalance": 300, "expiring": "soon", "birthdayDiscount": null }"#
        let loyalty = try JSONCoding.makeDecoder().decode(ClientLoyalty.self, from: Data(json.utf8))

        #expect(loyalty.bonusBalance == 300)
        #expect(loyalty.expiring == nil)
        #expect(loyalty.birthdayDiscount == nil)
    }

    @Test("GiftCertificate decodes as documented")
    func certificate() throws {
        let json = #"""
        { "id": 11, "code": "MIKAN-7K3Q-9F2D", "amount": 5000, "balance": 3000, "status": "active",
          "expiresAt": "<T>", "buyer": \#(Fixtures.clientRef), "recipientName": "Маше", "note": null,
          "saleId": 5, "saleNumber": 30,
          "operations": [ { "type": "issue", "amount": 5000, "saleId": 5, "saleNumber": 30, "createdAt": "<T>" },
                          { "type": "redeem", "amount": -2000, "saleId": 6, "saleNumber": 31, "createdAt": "<T>" } ],
          "createdAt": "<T>" }
        """#
        let certificate = try Fixtures.decode(GiftCertificate.self, json)

        #expect(certificate.code == "MIKAN-7K3Q-9F2D")
        #expect(certificate.balance == 3_000)
        #expect(certificate.status == .active)
        #expect(certificate.buyer?.fullName == "Иван Петров")
        #expect(certificate.operations.map(\.type) == [.issue, .redeem])
        #expect(certificate.isSpendable(at: Fixtures.referenceDate.addingTimeInterval(-60)))
        #expect(!certificate.isSpendable(at: Fixtures.referenceDate), "expired at expiresAt")
    }

    @Test("A certificate with an unknown status and no optional parts still decodes")
    func tolerantCertificate() throws {
        let json = #"{ "id": 2, "code": "MIKAN-H4WP-2XRT", "amount": 3000, "status": "frozen", "createdAt": "<T>" }"#
        let certificate = try Fixtures.decode(GiftCertificate.self, json)

        #expect(certificate.status == .unknown)
        #expect(certificate.balance == 3_000)
        #expect(certificate.operations.isEmpty)
        #expect(certificate.expiresAt == nil)
        #expect(CertificateText.unavailableReason(certificate) != nil)
    }

    @Test("The bonus ledger decodes, an unknown operation type is tolerated")
    func bonusHistory() throws {
        let json = #"""
        { "balance": 1200, "total": 2,
          "items": [ { "id": 2, "type": "spend", "amount": -300, "remaining": null, "expiresAt": null, "saleId": 6,
                       "saleNumber": 31, "note": null, "employee": \#(Fixtures.employeeRef), "createdAt": "<T>" },
                     { "id": 1, "type": "cashback_boost", "amount": 100, "remaining": 100, "expiresAt": "<T>",
                       "saleId": null, "saleNumber": null, "note": "Акция", "employee": null, "createdAt": "<T>" } ] }
        """#
        let page = try Fixtures.decode(BonusHistoryPage.self, json)

        #expect(page.balance == 1_200)
        #expect(page.total == 2)
        #expect(page.items.map(\.type) == [.spend, .unknown])
        #expect(page.items.map(BonusLedger.signedAmount) == [-300, 100])
    }

    @Test("Checkout takes the loyalty rules and certificate validity from the retention settings")
    func loyaltyRules() throws {
        let json = #"""
        { "loyalty": { "enabled": true, "cashbackPercent": 5, "maxPaymentPercent": 30, "expiryDays": null,
                       "notifyClient": true },
          "birthday": { "enabled": true, "sendAt": "10:00", "text": "…", "bonusAmount": 500, "bonusDays": 14,
                        "discountPercent": 10, "discountDaysBefore": 7, "discountDaysAfter": 7 },
          "winback": { "enabled": true, "afterMonths": 6, "sendAt": "12:00", "text": "…", "bonusAmount": 0,
                       "bonusDays": 30, "dailyLimit": 50 },
          "certificates": { "validityMonths": null } }
        """#
        let settings = try JSONCoding.makeDecoder().decode(RetentionSettings.self, from: Data(json.utf8))

        #expect(CheckoutLoyaltyRules(settings) == CheckoutLoyaltyRules(
            loyaltyEnabled: true, cashbackPercent: 5, maxPaymentPercent: 30, certificateValidityMonths: nil
        ))
        #expect(CheckoutLoyaltyRules.off.loyaltyEnabled == false)
    }

    // MARK: Encoding

    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONCoding.makeEncoder().encode(value)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("An ordinary sale sends no loyalty keys, exactly as before")
    func ordinaryPaymentsBody() throws {
        let body = try json(Payments(cash: 1_500, card: 0, transfer: 0))

        #expect(Set(body.keys) == ["cash", "card", "transfer", "qr", "deposit"])
    }

    @Test("Bonuses and certificates go out as payments.bonus and payments.certificates, never the sum")
    func creditsPaymentsBody() throws {
        let payments = Payments(
            cash: 1_000, card: 0, transfer: 0, bonus: 500, certificate: 1_500,
            certificates: [CertificatePayment(code: "MIKAN-7K3Q-9F2D", amount: 1_500)]
        )
        let body = try json(payments)

        #expect(body["bonus"] as? Int == 500)
        #expect(body["certificate"] == nil)
        let certificates = try #require(body["certificates"] as? [[String: Any]])
        #expect(certificates.first?["code"] as? String == "MIKAN-7K3Q-9F2D")
        #expect(certificates.first?["amount"] as? Int == 1_500)
    }

    @Test("A certificate line is sold as type certificate with its nominal and recipient")
    func certificateLineBody() throws {
        let line = CartLine.certificate(amount: 5_000, recipientName: "  Маше ")
        let body = try json(line.body)

        #expect(body["type"] as? String == "certificate")
        #expect(body["price"] as? Int == 5_000)
        #expect(body["quantity"] as? Int == 1)
        #expect(body["recipientName"] as? String == "Маше")
        #expect(body["productId"] == nil && body["serviceId"] == nil)

        let service = try json(CartLine(kind: .service(id: 3), name: "Хеликс", unitPrice: 3_000).body)
        #expect(service["recipientName"] == nil, "other lines never send it")
    }
}
