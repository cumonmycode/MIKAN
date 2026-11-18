import Foundation
import Testing
@testable import MIKAN

/// Studio expenses (docs/API.md «Expenses»): the wire format, the form and the analytics block.
@MainActor
struct StudioExpenseTests {
    private static func day(_ year: Int, _ month: Int, _ day: Int) -> Date {
        Calendar.app.date(from: DateComponents(year: year, month: month, day: day)) ?? .distantPast
    }

    private static let rentJSON = #"""
    { "id": 1, "name": "Аренда", "category": "rent", "amount": 60000, "repeat": "monthly", "date": "2026-10-01",
      "endDate": null, "note": null, "createdBy": null, "createdAt": "2026-10-01T10:00:00.000Z", "updatedAt": "2026-10-01T10:00:00.000Z" }
    """#

    @Test("An expense decodes; an unknown category reads as «Другое»")
    func decodes() throws {
        let rent = try JSONCoding.makeDecoder().decode(StudioExpense.self, from: Data(Self.rentJSON.utf8))
        #expect(rent.repeatKind == .monthly && rent.category == .rent && rent.amount == 60000 && rent.endDate == nil)
        let unknown = Self.rentJSON.replacingOccurrences(of: #""rent""#, with: #""coffee""#)
        #expect(try JSONCoding.makeDecoder().decode(StudioExpense.self, from: Data(unknown.utf8)).category == .other)
    }

    @Test("The body sends `repeat` and a cleared end date or note as null")
    func body() throws {
        var draft = ExpenseDraft(repeatKind: .monthly, today: Self.day(2026, 10, 1))
        draft.name = "  Свет "
        draft.category = .utilities
        draft.amount = 4000
        let json = try #require(String(data: try JSONEncoder().encode(draft.body()), encoding: .utf8))
        #expect(json.contains(#""repeat":"monthly""#))
        #expect(json.contains(#""endDate":null"#))
        #expect(json.contains(#""note":null"#))
        #expect(draft.body().name == "Свет")
        #expect(draft.body().date == "2026-10-01")
    }

    @Test("A one-time expense never sends an end date; a monthly one sends it when it ended")
    func endDate() {
        var draft = ExpenseDraft(repeatKind: .monthly, today: Self.day(2026, 10, 1))
        draft.hasEndDate = true
        draft.endDate = Self.day(2026, 12, 31)
        #expect(draft.body().endDate == "2026-12-31")
        draft.repeatKind = .once
        #expect(draft.body().endDate == nil)
    }

    @Test("The form names the first thing to fix")
    func problems() {
        var draft = ExpenseDraft(repeatKind: .once, today: Self.day(2026, 11, 18))
        #expect(draft.problem() == "Укажите название.")
        draft.name = "Шкаф"
        #expect(draft.problem() == "Укажите сумму больше нуля.")
        draft.amount = 15000
        #expect(draft.problem() == nil)
        draft.repeatKind = .monthly
        draft.hasEndDate = true
        draft.endDate = Self.day(2026, 11, 1)
        #expect(draft.problem() == "Дата окончания раньше даты начала.")
    }

    @Test("A monthly expense past its end date is ended")
    func ended() throws {
        let rent = try JSONCoding.makeDecoder().decode(StudioExpense.self, from: Data(Self.rentJSON.replacingOccurrences(
            of: #""endDate": null"#, with: #""endDate": "2026-10-31""#
        ).utf8))
        #expect(rent.isEnded(today: "2026-11-18"))
        #expect(!rent.isEnded(today: "2026-10-31"))
    }

    @Test("The analytics carry the expenses; an older server reads as none")
    func analytics() throws {
        let json = #"""
        { "from": "2026-10-31T21:00:00.000Z", "to": "2026-11-30T21:00:00.000Z",
          "totals": { "net": 0, "studioExpenses": 75000 },
          "expenses": { "total": 75000, "monthly": 60000, "once": 15000,
                        "byCategory": [ { "category": "rent", "amount": 60000 }, { "category": "furniture", "amount": 15000 } ],
                        "items": [ { "id": 1, "name": "Аренда", "category": "rent", "repeat": "monthly", "times": 1, "amount": 60000 } ] } }
        """#
        let report = try JSONCoding.makeDecoder().decode(ReportAnalytics.self, from: Data(json.utf8))
        #expect(report.totals.studioExpenses == 75000)
        #expect(report.expenses.once == 15000)
        #expect(report.expenses.items.first?.repeatKind == .monthly)
        #expect(!report.isEmpty)

        let old = #"{ "from": "2026-10-31T21:00:00.000Z", "to": "2026-11-30T21:00:00.000Z", "totals": { "net": 0 } }"#
        let older = try JSONCoding.makeDecoder().decode(ReportAnalytics.self, from: Data(old.utf8))
        #expect(older.expenses == AnalyticsExpenses())
        #expect(older.totals.studioExpenses == 0)
    }
}
