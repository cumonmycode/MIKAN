import Foundation
import Testing
@testable import MIKAN

/// Work schedules of masters: wire format, the hours editor's checks, exception rows and the calendar shading.
struct WorkScheduleTests {
    private static let moscow = TimeZone(identifier: "Europe/Moscow")!

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = moscow
        calendar.locale = Locale(identifier: "ru_RU")
        calendar.firstWeekday = 2
        return calendar
    }

    private static func day(_ year: Int, _ month: Int, _ day: Int, in calendar: Calendar = Self.calendar) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day))!
    }

    private static func scheduleDay(
        _ employeeId: Int, working: Bool = true, start: String? = "12:00", end: String? = "21:00",
        breaks: [ScheduleTimeRange] = [], source: ScheduleSource = .weekly, note: String? = nil
    ) -> ScheduleDay {
        ScheduleDay(
            employeeId: employeeId, date: "2026-10-21", working: working, start: working ? start : nil, end: working ? end : nil,
            breaks: breaks, source: source, note: note
        )
    }

    private static let pause = ScheduleTimeRange(start: "15:00", end: "15:30")

    // MARK: - Wire format

    @Test("WorkSchedule decodes days off as nulls and breaks with defaults")
    func decodesSchedule() throws {
        let json = #"""
        { "employeeId": 3,
          "weekly": [ { "start": "11:00", "end": "20:00", "breaks": [ { "start": "14:00", "end": "14:30" } ] },
                      null, { "start": "12:00", "end": "21:00" }, null, null, null, null ],
          "days": [ { "date": "2026-10-23", "off": true, "start": null, "end": null, "breaks": [], "note": "Отпуск" } ] }
        """#
        let schedule = try JSONCoding.makeDecoder().decode(WorkSchedule.self, from: Data(json.utf8))
        #expect(schedule.weekly?.count == 7)
        #expect(schedule.weekly?[0]?.breaks == [ScheduleTimeRange(start: "14:00", end: "14:30")])
        #expect(schedule.weekly?[1] == nil)
        #expect(schedule.weekly?[2]?.breaks == [])
        #expect(schedule.days.first?.note == "Отпуск")

        let none = try JSONCoding.makeDecoder().decode(WorkSchedule.self, from: Data(#"{ "employeeId": 3, "weekly": null, "days": [] }"#.utf8))
        #expect(none.weekly == nil)
    }

    @Test("ScheduleDayOut decodes, unknown sources count as the studio hours")
    func decodesDay() throws {
        let json = #"""
        { "items": [
          { "employeeId": 3, "date": "2026-10-21", "working": true, "start": "12:00", "end": "21:00",
            "breaks": [ { "start": "15:00", "end": "15:30" } ], "source": "weekly", "note": null },
          { "employeeId": 4, "date": "2026-10-21", "working": true, "start": "11:00", "end": "21:00",
            "breaks": [], "source": "rota", "note": null } ] }
        """#
        let items = try JSONCoding.makeDecoder().decode(ItemsResponse<ScheduleDay>.self, from: Data(json.utf8)).items
        #expect(items[0].isOwn)
        #expect(items[1].source == .studio)
        #expect(!items[1].isOwn)
    }

    @Test("Weekly bodies send null days and a null schedule explicitly")
    func encodesWeekly() throws {
        let hours = WorkHours(start: "12:00", end: "21:00", breaks: [Self.pause])
        let data = try JSONCoding.makeEncoder().encode(WeeklyScheduleBody(weekly: [hours, nil, nil, nil, nil, nil, nil]))
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let weekly = try #require(object["weekly"] as? [Any])
        #expect(weekly.count == 7)
        #expect(weekly[1] is NSNull)
        let monday = try #require(weekly[0] as? [String: Any])
        #expect(monday["start"] as? String == "12:00")

        let cleared = try JSONCoding.makeEncoder().encode(WeeklyScheduleBody(weekly: nil))
        #expect(String(decoding: cleared, as: UTF8.self) == #"{"weekly":null}"#)
    }

    // MARK: - Hours editor

    @Test("Hours drafts mirror the server's checks")
    func validatesHours() {
        var draft = WorkHoursDraft(start: 600, end: 1080)
        #expect(draft.problem == nil)
        draft.end = 600
        #expect(draft.problem == "Конец работы должен быть позже начала")
        draft.end = 1080
        draft.breaks = [.init(start: 540, end: 570)]
        #expect(draft.problem == "Перерыв 09:00–09:30 выходит за часы работы 10:00–18:00")
        draft.breaks = [.init(start: 810, end: 870), .init(start: 780, end: 840)]
        #expect(draft.problem == "Перерывы 13:00–14:00 и 13:30–14:30 пересекаются")
        draft.breaks = [.init(start: 840, end: 780)]
        #expect(draft.problem == "Конец перерыва должен быть позже начала")
        draft.breaks = [.init(start: 600, end: 630), .init(start: 630, end: 660), .init(start: 1050, end: 1080)]
        #expect(draft.problem == nil, "breaks may touch each other and the edges of the day")
    }

    @Test("Hours drafts read and write HH:MM, breaks sorted, midnight as 24:00")
    func convertsHours() {
        let studio = WorkdayHours(startMinute: 660, endMinute: 1260, timeZone: Self.moscow)
        let hours = WorkHours(start: "12:00", end: "24:00", breaks: [ScheduleTimeRange(start: "18:00", end: "18:15"), Self.pause])
        let draft = WorkHoursDraft(hours, studio: studio)
        #expect(draft.start == 720)
        #expect(draft.end == 1440)
        #expect(draft.hours == WorkHours(start: "12:00", end: "24:00", breaks: [Self.pause, ScheduleTimeRange(start: "18:00", end: "18:15")]))
        // No hours (a day off turning into a working day): the studio hours.
        #expect(WorkHoursDraft(nil, studio: studio).hours == WorkHours(start: "11:00", end: "21:00", breaks: []))
    }

    @Test("A new break goes into the middle of the day, then after the last one, up to six")
    func addsBreaks() {
        var draft = WorkHoursDraft(start: 600, end: 1260)
        draft.addBreak()
        #expect(draft.hours.breaks == [ScheduleTimeRange(start: "15:30", end: "16:00")])
        draft.addBreak()
        #expect(draft.hours.breaks.last == ScheduleTimeRange(start: "16:00", end: "16:30"))
        for _ in 0..<10 { draft.addBreak() }
        #expect(draft.breaks.count == WorkHoursDraft.maxBreaks)
        #expect(!draft.canAddBreak)
        #expect(draft.problem == nil)
    }

    // MARK: - Exceptions

    @Test("Consecutive identical exceptions show as one range")
    func groupsExceptions() {
        func off(_ date: String, note: String? = "Отпуск") -> ScheduleException {
            ScheduleException(date: date, off: true, start: nil, end: nil, breaks: [], note: note)
        }
        let short = ScheduleException(date: "2026-11-02", off: false, start: "10:00", end: "14:00", breaks: [], note: nil)
        let groups = ScheduleExceptionGroup.groups([off("2026-11-01"), off("2026-10-30"), off("2026-10-31"), short, off("2026-11-05", note: nil)])
        #expect(groups.map(\.id) == ["2026-10-30…2026-11-01", "2026-11-02…2026-11-02", "2026-11-05…2026-11-05"])
        #expect(groups[0].detail == "Выходной")
        #expect(groups[1].detail == "10:00–14:00")
        #expect(ScheduleExceptionGroup.nextDate(after: "2026-12-31") == "2027-01-01")
        #expect(ScheduleExceptionGroup.nextDate(after: "2026-03-28") == "2026-03-29")
    }

    @Test("Date ranges read naturally")
    func datesText() {
        #expect(WorkTimeText.dates(from: "2026-10-23", to: "2026-10-23") == "23 октября")
        #expect(WorkTimeText.dates(from: "2026-10-23", to: "2026-10-25") == "23–25 октября")
        #expect(WorkTimeText.dates(from: "2026-10-30", to: "2026-11-02") == "30 октября – 2 ноября")
    }

    @Test("Exception drafts build the request; a vacation is noted «Отпуск» and limited to 62 days")
    func buildsExceptions() throws {
        let calendar = Self.calendar
        var draft = ScheduleExceptionDraft(day: Self.day(2026, 10, 23), hours: WorkHoursDraft(start: 720, end: 1260))
        draft.to = Self.day(2026, 10, 30)
        #expect(draft.body(calendar: calendar) == ScheduleDaysBody(from: "2026-10-23", to: "2026-10-23", off: true))

        draft.kind = .vacation
        #expect(draft.body(calendar: calendar) == ScheduleDaysBody(from: "2026-10-23", to: "2026-10-30", off: true, note: "Отпуск"))
        #expect(draft.dayCount(calendar: calendar) == 8)
        draft.to = Self.day(2026, 12, 24)
        #expect(draft.problem(calendar: calendar) == "Не больше 62 дней за раз — добавьте отпуск частями")
        #expect(draft.body(calendar: calendar) == nil)

        draft.kind = .otherHours
        draft.note = " Учёба "
        draft.hours.breaks = [.init(start: 900, end: 930)]
        #expect(draft.body(calendar: calendar) == ScheduleDaysBody(
            from: "2026-10-23", to: "2026-10-23", off: false, start: "12:00", end: "21:00", breaks: [Self.pause], note: "Учёба"
        ))
        draft.hours.end = 700
        #expect(draft.body(calendar: calendar) == nil)
    }

    // MARK: - Calendar

    @Test("Working minutes leave out the breaks")
    func workingMinutes() {
        let day = Self.scheduleDay(3, breaks: [Self.pause])
        #expect(ScheduleShading.workingMinutes(day) == [720..<900, 930..<1260])
        #expect(ScheduleShading.workingMinutes(Self.scheduleDay(3, working: false)) == [])
        // Seen from a phone in Novosibirsk (UTC+7) the Moscow hours move 4 hours later, clipped at midnight.
        #expect(ScheduleShading.workingMinutes(day, offset: 240) == [960..<1140, 1170..<1440])
    }

    @Test("The studio offset matches the phone's and the studio's time zones")
    func studioOffset() {
        var novosibirsk = Self.calendar
        novosibirsk.timeZone = TimeZone(identifier: "Asia/Novosibirsk")!
        let localDay = Self.day(2026, 10, 21, in: novosibirsk)
        #expect(ScheduleShading.studioOffset(of: localDay, calendar: novosibirsk, studioTimeZone: Self.moscow) == 240)
        #expect(ScheduleShading.studioOffset(of: Self.day(2026, 10, 21), calendar: Self.calendar, studioTimeZone: Self.moscow) == 0)
    }

    @Test("One master: their non-working time inside the studio hours is shaded; a day off is marked")
    func shadesOneMaster() {
        let days = [Self.scheduleDay(3, breaks: [Self.pause]), Self.scheduleDay(4, working: false)]
        let fatima = ScheduleShading.column(days: days, masterId: 3, offset: 0, studioWindow: 660..<1260)
        #expect(fatima == ScheduleShading.Column(shaded: [660..<720, 900..<930], isDayOff: false, rails: []))
        let boris = ScheduleShading.column(days: days, masterId: 4, offset: 0, studioWindow: 660..<1260)
        #expect(boris.isDayOff)
        #expect(boris.shaded == [660..<1260])
        // Without an own schedule nothing is drawn: the grid shades the studio's off-hours itself.
        let studio = [Self.scheduleDay(5, start: "11:00", end: "21:00", source: .studio)]
        #expect(ScheduleShading.column(days: studio, masterId: 5, offset: 0, studioWindow: 660..<1260) == ScheduleShading.Column())
    }

    @Test("All masters: only time nobody works is shaded, with a stripe per master")
    func shadesAllMasters() {
        let days = [
            Self.scheduleDay(3, breaks: [Self.pause]),
            Self.scheduleDay(4, start: "11:00", end: "16:00"),
        ]
        let column = ScheduleShading.column(days: days, masterId: nil, offset: 0, studioWindow: 660..<1260)
        #expect(column.shaded == [])
        #expect(column.rails == [
            ScheduleShading.Rail(employeeId: 3, working: [720..<900, 930..<1260]),
            ScheduleShading.Rail(employeeId: 4, working: [660..<960]),
        ])
        let nobody = ScheduleShading.column(
            days: [Self.scheduleDay(3, working: false), Self.scheduleDay(4, working: false, source: .day)],
            masterId: nil, offset: 0, studioWindow: 660..<1260
        )
        #expect(nobody.isDayOff)
    }

    @Test("Masters off for the day are those whose own schedule says so")
    func offMasters() {
        let days = [
            Self.scheduleDay(3, working: false, note: "Отпуск"),
            Self.scheduleDay(4),
            Self.scheduleDay(5, working: false, source: .studio),
        ]
        #expect(ScheduleShading.offMasters(days: days, masterId: nil).map(\.employeeId) == [3])
        #expect(ScheduleShading.offMasters(days: days, masterId: 4).isEmpty)
    }

    @Test("The editor hint tells whether an appointment fits the master's day")
    func hint() {
        let day = Self.scheduleDay(3, breaks: [Self.pause])
        let at = { (hour: Int, minute: Int) in Self.calendar.date(from: DateComponents(year: 2026, month: 10, day: 21, hour: hour, minute: minute))! }
        let fits = { (start: Date, end: Date) in
            ScheduleShading.fits(day, start: start, end: end, calendar: Self.calendar, studioTimeZone: Self.moscow)
        }
        #expect(fits(at(13, 0), at(15, 0)))
        #expect(!fits(at(14, 30), at(15, 15)))
        #expect(!fits(at(11, 0), at(12, 30)))
        #expect(WorkTimeText.masterDay(day, name: "Фатима") == "Фатима работает 12:00–21:00, перерыв 15:00–15:30")
        #expect(WorkTimeText.masterDay(Self.scheduleDay(3, working: false, note: "Отпуск"), name: "Фатима") == "Фатима не работает в этот день (отпуск)")
    }
}
