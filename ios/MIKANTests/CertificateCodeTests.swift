import Foundation
import Testing
@testable import MIKAN

/// Gift certificate codes as staff type, paste or read them, and the texts around certificates and bonuses.
struct CertificateCodeTests {
    @Test("Any typed shape of a code becomes MIKAN-XXXX-XXXX", arguments: [
        ("MIKAN-7K3Q-9F2D", "MIKAN-7K3Q-9F2D"),
        ("mikan-7k3q-9f2d", "MIKAN-7K3Q-9F2D"),
        ("  MIKAN 7K3Q 9F2D ", "MIKAN-7K3Q-9F2D"),
        ("MIKAN7K3Q9F2D", "MIKAN-7K3Q-9F2D"),
        ("7K3Q-9F2D", "MIKAN-7K3Q-9F2D"),
        ("7k3q9f2d", "MIKAN-7K3Q-9F2D"),
        ("MIKAN–7K3Q—9F2D", "MIKAN-7K3Q-9F2D"),
    ])
    func normalize(input: String, expected: String) {
        #expect(CertificateCode.normalize(input) == expected)
    }

    @Test("Cyrillic look-alike letters typed on a Russian keyboard read as Latin")
    func lookAlikes() {
        #expect(CertificateCode.normalize("МIKAN-7K3Q-9F2D") == "MIKAN-7K3Q-9F2D", "a Cyrillic М")
        #expect(CertificateCode.normalize("7К3Р-9F2Е") == "MIKAN-7K3P-9F2E")
        #expect(CertificateCode.normalize("mikan-авсе-кмно") == "MIKAN-ABCE-KMHO")
    }

    @Test("Blank input is no code; a partial code stays as typed, uppercased")
    func partial() {
        #expect(CertificateCode.normalize("") == nil)
        #expect(CertificateCode.normalize(" - ") == nil)
        #expect(CertificateCode.normalize("7k3q") == "7K3Q")
        #expect(!CertificateCode.isComplete("7k3q"))
        #expect(CertificateCode.isComplete("mikan 7k3q 9f2d"))
        #expect(!CertificateCode.isComplete("MIKAN-7K3Q-9F2D1"))
    }

    @Test("The code is found in a sale line's name")
    func findInName() {
        #expect(CertificateCode.find(in: "Подарочный сертификат MIKAN-7K3Q-9F2D") == "MIKAN-7K3Q-9F2D")
        #expect(CertificateCode.find(in: "Подарочный сертификат") == nil)
        #expect(CertificateCode.find(in: "Прокол мочки") == nil)
    }

    @Test("The list search sends a whole code in its canonical form and anything else as typed")
    func searchQuery() {
        #expect(CertificateCode.searchQuery("mikan7k3q9f2d") == "MIKAN-7K3Q-9F2D")
        #expect(CertificateCode.searchQuery(" Маше ") == "Маше")
        #expect(CertificateCode.searchQuery("7K3Q") == "7K3Q")
    }

    // MARK: Texts

    private static func certificate(
        status: GiftCertificateStatus = .active, balance: Int = 3_000, expiresAt: Date? = nil
    ) -> GiftCertificate {
        GiftCertificate(
            id: 1, code: "MIKAN-7K3Q-9F2D", amount: 5_000, balance: balance, status: status, expiresAt: expiresAt,
            buyer: nil, recipientName: nil, note: nil, saleId: nil, saleNumber: nil, createdAt: Fixtures.referenceDate
        )
    }

    @Test("Why a certificate can't pay", arguments: [
        (GiftCertificateStatus.used, 0, "Сертификат уже использован полностью"),
        (.expired, 3_000, "Срок действия сертификата истёк"),
        (.cancelled, 3_000, "Сертификат отменён"),
        (.active, 0, "На сертификате не осталось денег"),
    ])
    func unavailableReason(status: GiftCertificateStatus, balance: Int, expected: String) {
        #expect(CertificateText.unavailableReason(Self.certificate(status: status, balance: balance)) == expected)
    }

    @Test("An active certificate past its date can't pay; one with money and time left can")
    func expiry() {
        let now = Fixtures.referenceDate
        let past = Self.certificate(expiresAt: now.addingTimeInterval(-1))
        let future = Self.certificate(expiresAt: now.addingTimeInterval(86_400))
        #expect(CertificateText.unavailableReason(past, now: now) == "Срок действия сертификата истёк")
        #expect(CertificateText.unavailableReason(future, now: now) == nil)
        #expect(CertificateText.unavailableReason(Self.certificate(), now: now) == nil, "no date — never expires")
        #expect(CertificateText.validity(nil) == "бессрочно")
    }

    @Test("Certificate operations: signed as sent; a debit sent unsigned still reads as a debit")
    func operationSigns() {
        #expect(CertificateText.signedAmount(type: .issue, amount: 5_000) == 5_000)
        #expect(CertificateText.signedAmount(type: .redeem, amount: -2_000) == -2_000)
        #expect(CertificateText.signedAmount(type: .redeem, amount: 2_000) == -2_000)
        #expect(CertificateText.signedAmount(type: .refund, amount: 2_000) == 2_000)
        #expect(CertificateText.signedAmount(type: .cancel, amount: -3_000) == -3_000)
        #expect(CertificateText.signedAmount(type: .expire, amount: -1_000) == -1_000)
    }

    @Test("Every documented operation type has its title", arguments: [
        (GiftCertificateOperationType.issue, "Продан"),
        (.redeem, "Оплата покупки"),
        (.refund, "Возврат покупки"),
        (.cancel, "Аннулирован"),
        (.expire, "Срок истёк"),
        (.unknown, "Операция"),
    ])
    func operationTitles(type: GiftCertificateOperationType, title: String) {
        #expect(CertificateText.operationTitle(type) == title)
    }

    @Test("Sold certificate nominal and validity texts")
    func saleTexts() {
        #expect(CertificateRules.isValidAmount(500))
        #expect(!CertificateRules.isValidAmount(100_001))
        #expect(CertificateRules.validityText(months: 12) == "Действует 12 месяцев с покупки")
        #expect(CertificateRules.validityText(months: 1) == "Действует 1 месяц с покупки")
        #expect(CertificateRules.validityText(months: nil) == "Действует бессрочно")
    }

    @Test("Owner and admin adjust bonuses; only the owner cancels a certificate", arguments: [
        (EmployeeRole.owner, true, true),
        (.admin, true, false),
        (.master, false, false),
    ])
    func permissions(role: EmployeeRole, adjusts: Bool, cancels: Bool) {
        let permissions = Permissions(role: role, employeeId: 1)
        #expect(permissions.adjustsBonuses == adjusts)
        #expect(permissions.cancelsCertificates == cancels)
    }

    @Test("Bonus ledger: spending and burning are debits; adjustments need a note and can't overdraw")
    func bonusLedger() {
        let date = Fixtures.referenceDate
        func operation(_ type: BonusOperationType, _ amount: Int) -> BonusOperation {
            BonusOperation(
                id: 1, type: type, amount: amount, remaining: nil, expiresAt: nil, saleId: nil, saleNumber: nil,
                note: nil, employee: nil, createdAt: date
            )
        }
        #expect(BonusLedger.signedAmount(operation(.spend, 300)) == -300)
        #expect(BonusLedger.signedAmount(operation(.spend, -300)) == -300)
        #expect(BonusLedger.signedAmount(operation(.expire, 200)) == -200)
        #expect(BonusLedger.signedAmount(operation(.earn, 75)) == 75)
        #expect(BonusLedger.signedAmount(operation(.reverse, -75)) == -75)
        #expect(BonusLedger.signedText(-300) == "−300")
        #expect(BonusLedger.signedText(1_500) == "+1\u{00A0}500")

        #expect(BonusLedger.isValidAdjustment(amount: 500, note: "Компенсация", balance: 0))
        #expect(!BonusLedger.isValidAdjustment(amount: 500, note: "  ", balance: 0))
        #expect(!BonusLedger.isValidAdjustment(amount: 0, note: "Ноль", balance: 100))
        #expect(BonusLedger.isValidAdjustment(amount: -100, note: "Ошибка", balance: 100))
        #expect(!BonusLedger.isValidAdjustment(amount: -101, note: "Ошибка", balance: 100))
    }
}
