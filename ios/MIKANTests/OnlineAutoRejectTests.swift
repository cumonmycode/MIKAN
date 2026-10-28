import Foundation
import Testing
@testable import MIKAN

/// `onlineBooking.confirmationHours` (docs/API.md «StudioSettings»): read with and without a server that knows it,
/// sent back only to one that does, offered and validated as the server limits it.
@MainActor
struct OnlineAutoRejectTests {
    private func decode(_ json: String) throws -> OnlineBookingSettings {
        try JSONCoding.makeDecoder().decode(OnlineBookingSettings.self, from: Data(json.utf8))
    }

    private func sent(_ settings: OnlineBookingSettings) throws -> [String: Any] {
        let data = try JSONCoding.makeEncoder().encode(settings)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("Hours, null and a missing key are three different things")
    func decoding() throws {
        #expect(try decode(#"{ "enabled": true, "confirmationHours": 24 }"#).autoReject == .after(hours: 24))
        #expect(try decode(#"{ "enabled": true, "confirmationHours": 6 }"#).autoReject == .after(hours: 6))
        #expect(try decode(#"{ "enabled": true, "confirmationHours": null }"#).autoReject == .never)
        let older = try decode(#"{ "enabled": true, "leadMinutes": 60 }"#)
        #expect(older.autoReject == nil)
        #expect(older.leadMinutes == 60)
    }

    @Test("Sent back as hours or an explicit null; never to a server that did not send it")
    func encoding() throws {
        var settings = OnlineBookingSettings()
        #expect(try sent(settings).keys.contains("confirmationHours") == false)
        #expect(try sent(settings)["leadMinutes"] as? Int == 120)

        settings.autoReject = .after(hours: 48)
        #expect(try sent(settings)["confirmationHours"] as? Int == 48)
        settings.autoReject = .never
        #expect(try sent(settings)["confirmationHours"] is NSNull)
    }

    @Test("The whole studio settings round-trip keeps the value")
    func roundTrip() throws {
        let json = Fixtures.studioSettings.replacingOccurrences(
            of: #""workdayEnd": "21:00" }"#,
            with: #""workdayEnd": "21:00", "onlineBooking": { "enabled": true, "leadMinutes": 120, "horizonDays": 60, "holdMinutes": 15, "stepMinutes": 30, "note": "", "confirmationHours": 12 } }"#
        )
        let studio = try JSONCoding.makeDecoder().decode(StudioSettings.self, from: Data(json.utf8))
        #expect(studio.onlineBooking?.autoReject == .after(hours: 12))
        let body = try #require(try JSONSerialization.jsonObject(with: JSONCoding.makeEncoder().encode(studio)) as? [String: Any])
        let online = try #require(body["onlineBooking"] as? [String: Any])
        #expect(online["confirmationHours"] as? Int == 12)
    }

    @Test("Hours and the JSON value map both ways")
    func hours() {
        #expect(OnlineAutoReject(hours: nil) == .never)
        #expect(OnlineAutoReject(hours: 3) == .after(hours: 3))
        #expect(OnlineAutoReject.never.hours == nil)
        #expect(OnlineAutoReject.standard.hours == 24)
    }

    @Test("Choices start with «off», keep a value set elsewhere and read in hours or days")
    func options() {
        let standard = OnlineBookingOptions.autoRejects(including: .standard)
        #expect(standard.first == .never)
        #expect(standard.dropFirst().compactMap(\.hours) == OnlineBookingOptions.autoRejectHourChoices)
        #expect(OnlineBookingOptions.autoRejects(including: .never) == standard)
        let custom = OnlineBookingOptions.autoRejects(including: .after(hours: 36)).compactMap(\.hours)
        #expect(custom.contains(36))
        #expect(custom == custom.sorted())
        #expect(OnlineBookingOptions.autoRejectHourChoices.allSatisfy(OnlineAutoReject.hoursRange.contains))

        #expect(OnlineBookingOptions.autoRejectTitle(.never) == "Выключена")
        #expect(OnlineBookingOptions.autoRejectTitle(.after(hours: 6)) == "Через 6 ч")
        #expect(OnlineBookingOptions.autoRejectTitle(.after(hours: 24)) == "Через 1 день")
        #expect(OnlineBookingOptions.autoRejectTitle(.after(hours: 48)) == "Через 2 дня")
        #expect(OnlineBookingOptions.autoRejectTitle(.after(hours: 168)) == "Через 7 дней")
        #expect(OnlineBookingOptions.hoursTitle(36) == "36 ч")
    }

    @Test("The footer names the term and the two hours before the start")
    func footer() {
        let on = OnlineBookingOptions.autoRejectFooter(.after(hours: 24))
        #expect(on.contains("за 1 день"))
        #expect(on.contains("за 2 часа до начала"))
        #expect(OnlineBookingOptions.autoRejectFooter(.never).contains("ждут"))
    }

    @Test("1…168 hours and «off» save; anything else is blocked")
    func validation() {
        var settings = OnlineBookingSettings()
        #expect(OnlineBookingRules.issue(settings) == nil, "an older server: nothing to check")
        for value in [OnlineAutoReject.never, .after(hours: 1), .after(hours: 168)] {
            settings.autoReject = value
            #expect(OnlineBookingRules.issue(settings) == nil)
        }
        for hours in [0, 169, -5] {
            settings.autoReject = .after(hours: hours)
            #expect(OnlineBookingRules.issue(settings)?.contains("Автоотмена") == true)
        }
    }
}
