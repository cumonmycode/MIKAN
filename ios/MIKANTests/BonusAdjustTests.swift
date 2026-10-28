import Foundation
import Testing
@testable import MIKAN

/// A manual bonus adjustment on the client card (`POST /clients/:id/bonuses`).
struct BonusAdjustTests {
    @Test("Added bonuses burn at the start of the day after the chosen one")
    func adjustExpiry() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "Europe/Moscow"))
        let day = try #require(calendar.date(from: DateComponents(year: 2026, month: 11, day: 2, hour: 15)))
        let expected = try #require(calendar.date(from: DateComponents(year: 2026, month: 11, day: 3)))
        #expect(BonusAdjustDates.endOfDay(day, calendar: calendar) == expected)
    }

    @Test("The adjustment body carries a signed amount, the note and an optional burn date")
    func body() throws {
        let body = BonusAdjustBody(amount: -200, note: "Ошибка кассира")
        let data = try JSONCoding.makeEncoder().encode(body)
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])

        #expect(json["amount"] as? Int == -200)
        #expect(json["note"] as? String == "Ошибка кассира")
        #expect(json["expiresAt"] == nil, "omitted — the bonuses never burn")
    }
}
