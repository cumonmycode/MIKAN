import Foundation
import Testing
@testable import MIKAN

/// Retention settings (docs/API.md «Retention settings»): decoding, the PUT body and the server's limits.
@MainActor
struct RetentionSettingsTests {
    /// The example from the contract.
    static let contractJSON = """
    { "loyalty": { "enabled": true, "cashbackPercent": 5, "maxPaymentPercent": 30, "expiryDays": null,
                   "notifyClient": true },
      "birthday": { "enabled": true, "sendAt": "10:00", "text": "{name}, с днём рождения! 🎂 …",
                    "bonusAmount": 500, "bonusDays": 14, "discountPercent": 10, "discountDaysBefore": 7,
                    "discountDaysAfter": 7 },
      "winback": { "enabled": true, "afterMonths": 6, "sendAt": "12:00", "text": "{name}, давно не виделись! …",
                   "bonusAmount": 0, "bonusDays": 30, "dailyLimit": 50 },
      "certificates": { "validityMonths": 12 } }
    """

    private func settings() throws -> RetentionSettings {
        try JSONCoding.makeDecoder().decode(RetentionSettings.self, from: Data(Self.contractJSON.utf8))
    }

    private func json(_ settings: RetentionSettings) throws -> [String: [String: Any]] {
        let data = try JSONCoding.makeEncoder().encode(settings)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: [String: Any]])
    }

    @Test("Decodes the contract example, and it is valid")
    func decoding() throws {
        let value = try settings()
        #expect(value.loyalty.expiryDays == nil)
        #expect(value.loyalty.cashbackPercent == 5)
        #expect(value.birthday.sendAt == "10:00")
        #expect(value.winback.dailyLimit == 50)
        #expect(value.certificates.validityMonths == 12)
        #expect(RetentionRules.issue(value) == nil)
    }

    @Test("«Never» goes out as an explicit null so the server clears the old value")
    func explicitNulls() throws {
        var value = try settings()
        value.certificates.validityMonths = nil
        let body = try json(value)
        #expect(Set(body.keys) == ["loyalty", "birthday", "winback", "certificates"], "every group in full")
        #expect(body["loyalty"]?["expiryDays"] is NSNull)
        #expect(body["certificates"]?["validityMonths"] is NSNull)
        #expect(body["birthday"]?["discountDaysAfter"] as? Int == 7)

        value.loyalty.expiryDays = 180
        value.certificates.validityMonths = 24
        let limited = try json(value)
        #expect(limited["loyalty"]?["expiryDays"] as? Int == 180)
        #expect(limited["certificates"]?["validityMonths"] as? Int == 24)
    }

    @Test("Loyalty: cashback 0…50%, bonus payment 0…100%, expiry 1…3650 days or never")
    func loyaltyLimits() throws {
        let base = try settings().loyalty
        func issue(_ change: (inout LoyaltySettings) -> Void) -> String? {
            var loyalty = base
            change(&loyalty)
            return RetentionRules.loyaltyIssue(loyalty)
        }
        #expect(issue { $0.cashbackPercent = 50 } == nil)
        #expect(issue { $0.cashbackPercent = 51 } != nil)
        #expect(issue { $0.cashbackPercent = -1 } != nil)
        #expect(issue { $0.maxPaymentPercent = 100 } == nil)
        #expect(issue { $0.maxPaymentPercent = 101 } != nil)
        #expect(issue { $0.expiryDays = 1 } == nil)
        #expect(issue { $0.expiryDays = 3650 } == nil)
        #expect(issue { $0.expiryDays = 0 } != nil)
        #expect(issue { $0.expiryDays = 3651 } != nil)
        #expect(issue { $0.expiryDays = nil } == nil)
    }

    @Test("Birthday: time, a text of 1…1000 characters, gift and discount window")
    func birthdayLimits() throws {
        let base = try settings().birthday
        func issue(_ change: (inout BirthdaySettings) -> Void) -> String? {
            var birthday = base
            change(&birthday)
            return RetentionRules.birthdayIssue(birthday)
        }
        #expect(issue { $0.sendAt = "9:30" } == nil)
        #expect(issue { $0.sendAt = "25:00" } != nil)
        #expect(issue { $0.sendAt = "10-00" } != nil)
        #expect(issue { $0.text = "   " } != nil)
        #expect(issue { $0.text = String(repeating: "а", count: 1000) } == nil)
        #expect(issue { $0.text = String(repeating: "а", count: 1001) } != nil)
        #expect(issue { $0.text = String(repeating: "🎂", count: 501) } != nil, "an emoji counts twice, like on the server")
        #expect(issue { $0.bonusAmount = 0 } == nil)
        #expect(issue { $0.bonusAmount = 100_001 } != nil)
        #expect(issue { $0.bonusDays = 0 } != nil)
        #expect(issue { $0.bonusDays = 366 } != nil)
        #expect(issue { $0.discountPercent = 101 } != nil)
        #expect(issue { $0.discountDaysBefore = 31 } == nil)
        #expect(issue { $0.discountDaysAfter = 32 } != nil)
        #expect(issue { $0.enabled = false; $0.text = "" } != nil, "a switched-off group is still sent and checked")
    }

    @Test("Win-back: 1…24 months, time, text, gift and 1…500 messages a day")
    func winbackLimits() throws {
        let base = try settings().winback
        func issue(_ change: (inout WinbackSettings) -> Void) -> String? {
            var winback = base
            change(&winback)
            return RetentionRules.winbackIssue(winback)
        }
        #expect(issue { $0.afterMonths = 1 } == nil)
        #expect(issue { $0.afterMonths = 0 } != nil)
        #expect(issue { $0.afterMonths = 25 } != nil)
        #expect(issue { $0.sendAt = "24:00" } == nil, "the server accepts 24:00")
        #expect(issue { $0.text = "" } != nil)
        #expect(issue { $0.dailyLimit = 500 } == nil)
        #expect(issue { $0.dailyLimit = 0 } != nil)
        #expect(issue { $0.dailyLimit = 501 } != nil)
        #expect(issue { $0.bonusDays = 365 } == nil)
    }

    @Test("Certificates: 1…60 months or never")
    func certificateLimits() {
        #expect(RetentionRules.certificatesIssue(CertificateSettings(validityMonths: nil)) == nil)
        #expect(RetentionRules.certificatesIssue(CertificateSettings(validityMonths: 60)) == nil)
        #expect(RetentionRules.certificatesIssue(CertificateSettings(validityMonths: 0)) != nil)
        #expect(RetentionRules.certificatesIssue(CertificateSettings(validityMonths: 61)) != nil)
    }

    @Test("The whole form reports its first problem")
    func firstIssue() throws {
        var value = try settings()
        value.winback.dailyLimit = 0
        value.certificates.validityMonths = 99
        #expect(RetentionRules.issue(value) == RetentionRules.winbackIssue(value.winback))
    }
}
