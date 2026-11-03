import Foundation
import Testing
@testable import MIKAN

/// `loyalty` of `GET /reports/analytics` (docs/API.md «Analytics»): decoded from the server or left at zero by an older
/// one, shown only when something is not zero, with its rows and the CSV section.
@MainActor
struct AnalyticsLoyaltyTests {
    private static let base = #"""
    { "from": "2026-10-12T21:00:00.000Z", "to": "2026-10-15T21:00:00.000Z",
      "totals": { "net": 0, "gross": 0, "refunds": 0, "salesCount": 0 }<LOYALTY> }
    """#
    private static let placeholder = "<LOYALTY>"

    private func analytics(loyalty: String?) throws -> ReportAnalytics {
        let json = Self.base.replacingOccurrences(of: Self.placeholder, with: loyalty.map { #", "loyalty": \#($0)"# } ?? "")
        return try JSONCoding.makeDecoder().decode(ReportAnalytics.self, from: Data(json.utf8))
    }

    private static let documented = #"""
    { "bonusEarned": 180, "bonusSpent": 900, "bonusExpired": 200, "bonusOutstanding": 280,
      "certificatesSold": 6000, "certificatesRedeemed": 0, "certificatesExpired": 0, "certificatesCancelled": 0,
      "certificatesOutstanding": 6000 }
    """#

    @Test("The documented loyalty block decodes field by field")
    func decodes() throws {
        let loyalty = try analytics(loyalty: Self.documented).loyalty
        #expect(loyalty == AnalyticsLoyalty(
            bonusEarned: 180, bonusSpent: 900, bonusExpired: 200, bonusOutstanding: 280,
            certificatesSold: 6000, certificatesRedeemed: 0, certificatesExpired: 0, certificatesCancelled: 0,
            certificatesOutstanding: 6000
        ))
        #expect(loyalty.hasBonuses)
        #expect(loyalty.hasCertificates)
        #expect(!loyalty.isZero)
        #expect(loyalty.hasActivity)
    }

    @Test("An older server without loyalty, a null block or missing numbers read as zero")
    func tolerant() throws {
        #expect(try analytics(loyalty: nil).loyalty == .zero)
        #expect(try analytics(loyalty: "null").loyalty == .zero)
        let partial = try analytics(loyalty: #"{ "bonusEarned": 50 }"#).loyalty
        #expect(partial.bonusEarned == 50)
        #expect(partial.certificatesOutstanding == 0)
        #expect(partial.hasBonuses)
        #expect(!partial.hasCertificates)
    }

    @Test("All zeros hide the card; balances alone show it but are no activity of the period")
    func visibility() {
        #expect(AnalyticsLoyalty.zero.isZero)
        #expect(!AnalyticsLoyalty.zero.hasActivity)
        let leftovers = AnalyticsLoyalty(bonusOutstanding: 500, certificatesOutstanding: 3000)
        #expect(!leftovers.isZero)
        #expect(!leftovers.hasActivity)
        #expect(AnalyticsLoyalty(certificatesCancelled: 1000).hasActivity)
        #expect(AnalyticsLoyalty(bonusEarned: -200).hasBonuses, "a manual debit makes earned negative")
    }

    @Test("A period with only a certificate sold is not empty")
    func certificateOnlyPeriod() throws {
        var a = try analytics(loyalty: nil)
        #expect(a.isEmpty)
        a.loyalty = AnalyticsLoyalty(certificatesSold: 5000, certificatesOutstanding: 5000)
        #expect(!a.isEmpty)
        a.loyalty = AnalyticsLoyalty(bonusOutstanding: 900)
        #expect(a.isEmpty, "balances left from earlier periods are not activity")
    }

    @Test("Rows follow the ledger: operations of the period, then the balance at its end")
    func rows() {
        let loyalty = AnalyticsLoyalty(
            bonusEarned: 180, bonusSpent: 900, bonusExpired: 200, bonusOutstanding: 280,
            certificatesSold: 6000, certificatesRedeemed: 1000, certificatesExpired: 500, certificatesCancelled: 250,
            certificatesOutstanding: 4250
        )
        let bonuses = AnalyticsLoyaltyText.bonusRows(loyalty)
        #expect(bonuses.map(\.amount) == [180, 900, 200, 280])
        #expect(bonuses.map(\.isBalance) == [false, false, false, true])
        #expect(bonuses.allSatisfy { !$0.detail.isEmpty })
        let certificates = AnalyticsLoyaltyText.certificateRows(loyalty)
        #expect(certificates.map(\.amount) == [6000, 1000, 500, 250, 4250])
        #expect(certificates.last?.isBalance == true)
        #expect(Set(certificates.map(\.id)).count == certificates.count)
    }

    @Test("Bonuses read as a count with a Russian plural and a real minus")
    func bonusText() {
        #expect(AnalyticsLoyaltyText.bonuses(1) == "1 бонус")
        #expect(AnalyticsLoyaltyText.bonuses(3) == "3 бонуса")
        #expect(AnalyticsLoyaltyText.bonuses(0) == "0 бонусов")
        #expect(AnalyticsLoyaltyText.bonuses(1_200) == "1\u{00A0}200 бонусов")
        #expect(AnalyticsLoyaltyText.bonuses(-21) == "−21 бонус")
    }

    @Test("The CSV export has the loyalty section only when there is something in it")
    func csv() throws {
        let empty = AnalyticsCSV.loyalty(.zero)
        #expect(empty.isEmpty)
        let rows = AnalyticsCSV.loyalty(AnalyticsLoyalty(bonusEarned: 180, certificatesSold: 6000, certificatesOutstanding: 6000))
        #expect(rows.first == ["Бонусы", "Бонусов"])
        #expect(rows.contains(["Начислено", "180"]))
        #expect(rows.contains(["Продано", "6000"]))
        #expect(rows.contains(["Не потрачено", "6000"]))

        let a = try analytics(loyalty: nil)
        let file = AnalyticsCSV.make(a, period: "13–15 октября", previousPeriod: "10–12 октября")
        #expect(!file.contains("Подарочные сертификаты"))
        #expect(!file.contains("\r\n\r\n\r\n"), "no blank section is left behind")
    }
}
