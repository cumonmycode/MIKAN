import Foundation
import Testing
@testable import MIKAN

/// Birthdays without the year (docs/API.md «Collecting birthdays»): stored with the year 1900, shown as day and month.
@Suite("Birthday")
struct BirthdayTests {
    private func client(birthday: String?) -> Client {
        Client(
            id: 7, name: "Анна", lastName: nil, phone: "+79991234567", instagram: nil, telegramNick: nil,
            birthday: birthday, notes: nil, source: nil, telegramLinked: false,
            telegramUsername: nil, botEnabled: true, archived: false,
            createdAt: Fixtures.referenceDate, updatedAt: Fixtures.referenceDate, stats: nil
        )
    }

    private func sent(_ draft: ClientDraft) throws -> Any? {
        let data = try JSONEncoder().encode(draft.body())
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        return json["birthday"]
    }

    @Test("The year 1900 is «year unknown»: day and month only, 29 February included")
    func yearUnknown() throws {
        let april = try #require(Birthday("1900-04-12"))
        #expect(april.year == nil)
        #expect(april.text == "12 апреля")
        #expect(april.string == "1900-04-12")
        #expect(try #require(Birthday("1900-02-29")).text == "29 февраля")
        #expect(Birthday("1995-02-29") == nil, "1995 has no 29 February")
        #expect(Birthday("1900-02-30") == nil)
        #expect(Birthday("12.04.1995") == nil)
        #expect(Birthday(nil) == nil)
    }

    @Test("A known year is shown as the full date, as before")
    func yearKnown() throws {
        let birthday = try #require(Birthday("1995-04-12"))
        #expect(birthday.year == 1995)
        #expect(birthday.text == DateText.fullDate(try #require(CalendarDay.date(from: "1995-04-12"))))
        #expect(birthday.text.contains("1995"))
        #expect(birthday.string == "1995-04-12")
    }

    @Test("A year-less card opens with «Без года» and saves back unchanged")
    func draftRoundTrip() throws {
        let draft = ClientDraft(client: client(birthday: "1900-02-29"))
        #expect(draft.hasBirthday)
        #expect(draft.birthdayWithoutYear)
        #expect(draft.birthdayDay == 29)
        #expect(draft.birthdayMonth == 2)
        #expect(try sent(draft) as? String == "1900-02-29")

        let full = ClientDraft(client: client(birthday: "1995-04-12"))
        #expect(!full.birthdayWithoutYear)
        #expect(try sent(full) as? String == "1995-04-12")

        let none = ClientDraft(client: client(birthday: nil))
        #expect(!none.hasBirthday)
        #expect(try sent(none) is NSNull)
    }

    @Test("«Без года» carries the day and the month over, and back into the date with its year")
    func switchingYear() throws {
        var draft = ClientDraft(client: client(birthday: "1995-04-12"))
        draft.birthdayWithoutYear = true
        #expect(draft.birthdayDay == 12)
        #expect(draft.birthdayMonth == 4)
        #expect(try sent(draft) as? String == "1900-04-12")

        draft.birthdayDay = 31
        draft.birthdayMonth = 6
        #expect(draft.birthdayDay == 30, "June has 30 days")
        draft.birthdayWithoutYear = false
        #expect(try sent(draft) as? String == "1995-06-30")
    }

    @Test("A new card can be given only the day and the month")
    func newCardWithoutYear() throws {
        var draft = ClientDraft()
        draft.hasBirthday = true
        draft.birthdayWithoutYear = true
        draft.birthdayMonth = 2
        draft.birthdayDay = 29
        #expect(try sent(draft) as? String == "1900-02-29")
    }

    @Test("Duplicates show a year-less birthday without the year")
    func mergeDisplay() {
        #expect(MergeFold.display(.birthday, "1900-04-12") == "12 апреля")
        let rows = DuplicateComparison.rows([client(birthday: "1900-04-12"), client(birthday: nil)])
        #expect(rows.first { $0.title == "Дата рождения" }?.values == ["12 апреля", nil])
    }

    @Test("Month names for the day-and-month picker")
    func monthNames() {
        #expect(Birthday.monthName(4) == "Апрель")
        #expect(Birthday.monthName(12) == "Декабрь")
        #expect(Birthday.daysIn(month: 2, year: nil) == 29)
        #expect(Birthday.daysIn(month: 2, year: 2027) == 28)
    }
}
