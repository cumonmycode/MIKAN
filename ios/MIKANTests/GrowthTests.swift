import Foundation
import Testing
@testable import MIKAN

/// `GET /reports/growth` as docs/API.md «Reports» shows it.
private let growthJSON = #"""
{ "from": "2026-09-30T21:00:00.000Z", "to": "2026-10-31T21:00:00.000Z",
  "funnel": { "bookingRequests": { "created": 12, "processed": 9, "rejected": 2, "open": 1 },
              "online": { "created": 20, "byChannel": { "bot": 8, "miniapp": 7, "web": 5 }, "confirmed": 15,
                          "rejected": 2, "expired": 1, "cancelledByClient": 1, "completed": 11, "awaiting": 1 },
              "appointments": { "created": 80, "byChannel": { "app": 60, "bot": 8, "miniapp": 7, "web": 5 },
                                "completed": 62, "cancelled": 9, "noShow": 3 } },
  "load": [ { "employee": { "id": 2, "name": "Анна", "color": "#FF7A1A" }, "workingMinutes": 9600, "bookedMinutes": 6240,
              "completedMinutes": 5400, "loadPercent": 65,
              "byWeekday": [ { "weekday": 1, "workingMinutes": 1440, "bookedMinutes": 900 } ] },
            { "employee": { "id": 3, "name": "Фатима", "color": null }, "workingMinutes": 0, "bookedMinutes": 60,
              "completedMinutes": 60, "loadPercent": null, "byWeekday": [] } ],
  "retention": { "newClients": 14, "returnedWithin90Days": 5, "repeatRatePercent": 35.7, "averageDaysBetweenVisits": 74,
                 "cohorts": [ { "month": "2026-05", "clients": 30, "returned30": 4, "returned90": 9, "returned180": 12 } ] },
  "value": { "clientsWithVisits": 610, "averageRevenuePerClient": 5300, "averageVisitsPerClient": 2.1,
             "top10PercentShare": 38.5 },
  "sources": [ { "source": "instagram", "newClients": 6, "revenue": 42000 } ] }
"""#

private func decode(_ json: String) throws -> ReportGrowth {
    try JSONCoding.makeDecoder().decode(ReportGrowth.self, from: Data(json.utf8))
}

/// Gregorian, Monday first, Moscow time — the studio's calendar.
private func moscow() throws -> Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.locale = Locale(identifier: "ru_RU")
    calendar.timeZone = try #require(TimeZone(identifier: "Europe/Moscow"))
    calendar.firstWeekday = 2
    return calendar
}

@MainActor
struct GrowthDecodingTests {
    @Test("The contract's example decodes in full")
    func decodesContract() throws {
        let growth = try decode(growthJSON)
        #expect(growth.funnel.bookingRequests == GrowthRequests(created: 12, processed: 9, rejected: 2, open: 1))
        #expect(growth.funnel.online.byChannel == ["bot": 8, "miniapp": 7, "web": 5])
        #expect(growth.funnel.online.confirmed == 15)
        #expect(growth.funnel.online.cancelledByClient == 1)
        #expect(growth.funnel.appointments.byChannel["app"] == 60)
        #expect(growth.funnel.appointments.noShow == 3)
        #expect(growth.load.map(\.employee.name) == ["Анна", "Фатима"])
        #expect(growth.load[0].loadPercent == 65)
        #expect(growth.load[0].byWeekday == [GrowthWeekdayLoad(weekday: 1, workingMinutes: 1440, bookedMinutes: 900)])
        #expect(growth.load[1].loadPercent == nil, "a master without working time")
        #expect(growth.retention.repeatRatePercent == 35.7)
        #expect(growth.retention.averageDaysBetweenVisits == 74)
        #expect(growth.retention.cohorts == [GrowthCohort(month: "2026-05", clients: 30, returned30: 4, returned90: 9, returned180: 12)])
        #expect(growth.value == GrowthValue(clientsWithVisits: 610, averageRevenuePerClient: 5300, averageVisitsPerClient: 2.1, top10PercentShare: 38.5))
        #expect(growth.sources == [GrowthSource(source: "instagram", newClients: 6, revenue: 42_000)])
        #expect(!growth.isEmpty)
    }

    @Test("A server that sends only the period gives an empty report")
    func toleratesMissingSections() throws {
        let growth = try decode(#"{ "from": "2026-09-30T21:00:00.000Z", "to": "2026-10-31T21:00:00.000Z" }"#)
        #expect(growth.funnel == GrowthFunnel())
        #expect(growth.load.isEmpty)
        #expect(growth.retention == GrowthRetention())
        #expect(growth.value == GrowthValue())
        #expect(growth.sources.isEmpty)
        #expect(growth.isEmpty)
    }

    @Test("Nulls, missing numbers, odd lists and unknown channels do not break the report")
    func toleratesOddValues() throws {
        let growth = try decode(#"""
        { "from": "2026-09-30T21:00:00.000Z", "to": "2026-10-31T21:00:00.000Z",
          "funnel": { "bookingRequests": null, "online": { "created": 3, "byChannel": "nope" },
                      "appointments": { "created": 4, "byChannel": { "app": 2, "kiosk": 2 } } },
          "load": [ { "workingMinutes": 60 },
                    { "employee": { "id": 5, "name": "Лия", "color": "#000000" }, "loadPercent": 72.4 } ],
          "retention": { "newClients": 3, "repeatRatePercent": null, "averageDaysBetweenVisits": 41.6,
                         "cohorts": [ { "month": "2026-10" }, 7, { "clients": 2 } ] },
          "value": { "averageVisitsPerClient": 3 },
          "sources": { "source": "instagram" },
          "somethingNew": { "x": 1 } }
        """#)
        #expect(growth.funnel.bookingRequests == GrowthRequests())
        #expect(growth.funnel.online.created == 3)
        #expect(growth.funnel.online.byChannel.isEmpty)
        #expect(growth.funnel.appointments.byChannel == ["app": 2, "kiosk": 2])
        #expect(growth.load.count == 1, "the entry without an employee is skipped")
        #expect(growth.load.first?.loadPercent == 72.4)
        #expect(growth.load.first?.workingMinutes == 0)
        #expect(growth.retention.repeatRatePercent == nil)
        #expect(growth.retention.averageDaysBetweenVisits == 42)
        #expect(growth.retention.cohorts == [GrowthCohort(month: "2026-10")], "a number and a cohort without a month are skipped")
        #expect(growth.value.averageVisitsPerClient == 3)
        #expect(growth.value.top10PercentShare == nil)
        #expect(growth.sources.isEmpty, "not a list")
    }
}

@MainActor
struct GrowthTextTests {
    @Test("Percents are whole, «—» when nothing can be divided")
    func percents() {
        #expect(GrowthText.wholePercent(65) == "65\u{00A0}%")
        #expect(GrowthText.wholePercent(28.5) == "29\u{00A0}%")
        #expect(GrowthText.wholePercent(nil) == "—")
        #expect(GrowthText.conversion(15, of: 20) == "75\u{00A0}%")
        #expect(GrowthText.conversion(1, of: 3) == "33\u{00A0}%")
        #expect(GrowthText.conversion(3, of: 0) == "—")
        #expect(GrowthText.fraction(15, of: 20) == 0.75)
        #expect(GrowthText.fraction(30, of: 20) == 1, "a bar never overflows")
        #expect(GrowthText.fraction(3, of: 0) == 0)
        #expect(GrowthText.decimal(2.1) == "2,1")
        #expect(GrowthText.decimal(2) == "2")
    }

    @Test("Durations read as minutes, hours, or both")
    func durations() {
        #expect(GrowthText.duration(minutes: 45) == "45\u{00A0}мин")
        #expect(GrowthText.duration(minutes: 0) == "0\u{00A0}мин")
        #expect(GrowthText.duration(minutes: 120) == "2\u{00A0}ч")
        #expect(GrowthText.duration(minutes: 150) == "2\u{00A0}ч 30\u{00A0}мин")
        let long = GrowthText.duration(minutes: 75_000)
        #expect(long.filter(\.isNumber) == "1250")
        #expect(long.hasSuffix("ч"))
    }

    @Test("Funnel steps are shares of the first step; losses list only what happened")
    func funnelSteps() {
        let online = GrowthOnline(created: 20, confirmed: 15, rejected: 2, expired: 1, cancelledByClient: 1, completed: 11, awaiting: 1)
        let steps = GrowthText.onlineSteps(online)
        #expect(steps.map(\.count) == [20, 15, 11])
        #expect(steps.map(\.percent) == ["100\u{00A0}%", "75\u{00A0}%", "55\u{00A0}%"])
        #expect(steps.map(\.fraction) == [1, 0.75, 0.55])
        #expect(GrowthText.onlineLosses(online) == "Отклонены: 2 · Не оплачены вовремя: 1 · Отменены клиентом: 1 · Ждут ответа: 1")
        #expect(GrowthText.onlineLosses(GrowthOnline(created: 3, confirmed: 3)) == nil)
        #expect(GrowthText.requestLosses(GrowthRequests(created: 4, processed: 3, open: 1)) == "Ждут обработки: 1")
        #expect(GrowthText.appointmentSteps(GrowthAppointments()).map(\.percent) == ["—", "—", "—", "—"])
    }

    @Test("Channels: known ones in a fixed order, then new ones by name; empty ones left out")
    func channels() {
        let line = GrowthText.channelLine(["bot": 8, "miniapp": 7, "web": 5, "app": 60, "kiosk": 2, "phone": 0])
        #expect(line == "Приложение 60 · Сайт 5 · Mini App 7 · Бот 8 · kiosk 2")
        #expect(GrowthText.channelLine([:]) == nil)
        #expect(GrowthText.channelLine(["web": 0]) == nil)
    }

    @Test("Load: seven weekdays, details and a bar that never overflows")
    func load() {
        let anna = EmployeeRef(id: 2, name: "Анна", color: nil)
        let busy = GrowthMasterLoad(
            employee: anna, workingMinutes: 9600, bookedMinutes: 6240, completedMinutes: 5400, loadPercent: 65,
            byWeekday: [GrowthWeekdayLoad(weekday: 3, workingMinutes: 480, bookedMinutes: 120)]
        )
        let week = GrowthText.weekdays(busy)
        #expect(week.map(\.weekday) == [1, 2, 3, 4, 5, 6, 7])
        #expect(week[2].bookedMinutes == 120)
        #expect(week[0] == GrowthWeekdayLoad(weekday: 1))
        #expect(GrowthText.weekdayPercent(week[2]) == "25\u{00A0}%")
        #expect(GrowthText.weekdayPercent(week[0]) == "—")
        #expect(GrowthText.loadDetail(busy) == "Занято 104\u{00A0}ч из 160\u{00A0}ч · проведено 90\u{00A0}ч")
        #expect(GrowthText.loadFraction(busy) == 0.65)

        let overtime = GrowthMasterLoad(employee: anna, workingMinutes: 600, bookedMinutes: 720, loadPercent: 120)
        #expect(GrowthText.loadFraction(overtime) == 1)
        let off = GrowthMasterLoad(employee: anna, bookedMinutes: 60, loadPercent: nil)
        #expect(GrowthText.loadFraction(off) == 0)
        #expect(GrowthText.loadDetail(off) == "Нет рабочего времени по графику · записей на 1\u{00A0}ч")
        #expect(GrowthText.loadDetail(GrowthMasterLoad(employee: anna)) == "Нет рабочего времени по графику")
    }

    @Test("Months, sources and their order")
    func monthsAndSources() {
        #expect(GrowthText.monthTitle("2025-09") == "Сен 2025")
        #expect(GrowthText.monthTitle("2026-05") == "Май 2026")
        #expect(GrowthText.monthTitle("2026-13") == "2026-13")
        #expect(GrowthText.monthTitle("soon") == "soon")
        #expect(GrowthText.sourceTitle("instagram") == "Instagram")
        #expect(GrowthText.sourceTitle("не указан") == "Не указан")
        #expect(GrowthText.sourceTitle("  ") == "Не указан")
        let sorted = GrowthText.sortedSources([
            GrowthSource(source: "telegram", newClients: 2, revenue: 100),
            GrowthSource(source: "instagram", newClients: 6, revenue: 0),
            GrowthSource(source: "рекомендация", newClients: 2, revenue: 900),
            GrowthSource(source: "другое", newClients: 2, revenue: 100),
        ])
        #expect(sorted.map(\.source) == ["instagram", "рекомендация", "telegram", "другое"])
        #expect(GrowthText.clients(1) == "1 клиент")
        #expect(GrowthText.clients(3) == "3 клиента")
        #expect(GrowthText.clients(14) == "14 клиентов")
    }

    @Test("A cohort cell is final once every client of the month has had the whole window")
    func cohortWindow() throws {
        let calendar = try moscow()
        let october30 = try #require(calendar.date(from: DateComponents(year: 2026, month: 10, day: 30, hour: 23)))
        let october31 = try #require(calendar.date(from: DateComponents(year: 2026, month: 10, day: 31)))
        #expect(!GrowthText.cohortWindowClosed(month: "2026-09", days: 30, now: october30, calendar: calendar))
        #expect(GrowthText.cohortWindowClosed(month: "2026-09", days: 30, now: october31, calendar: calendar))
        #expect(!GrowthText.cohortWindowClosed(month: "2026-09", days: 90, now: october31, calendar: calendar))
        #expect(GrowthText.cohortWindowClosed(month: "2025-10", days: 180, now: october31, calendar: calendar))
        #expect(GrowthText.cohortWindowClosed(month: "bad", days: 30, now: october31, calendar: calendar), "nothing to wait for")
    }
}

@MainActor
struct GrowthHeatScaleTests {
    private let cohorts = [
        GrowthCohort(month: "2026-08", clients: 10, returned30: 1, returned90: 4, returned180: 5),
        GrowthCohort(month: "2026-09", clients: 4, returned30: 0, returned90: 1, returned180: 1),
        GrowthCohort(month: "2026-10"),
    ]

    @Test("Shares per window; none without clients")
    func shares() {
        #expect(GrowthHeatScale.share(cohorts[0], days: 30) == 0.1)
        #expect(GrowthHeatScale.share(cohorts[0], days: 90) == 0.4)
        #expect(GrowthHeatScale.share(cohorts[0], days: 180) == 0.5)
        #expect(GrowthHeatScale.share(cohorts[1], days: 30) == 0)
        #expect(GrowthHeatScale.share(cohorts[2], days: 90) == nil)
        #expect(GrowthHeatScale.maximum(cohorts) == 0.5)
        #expect(GrowthHeatScale.maximum([]) == 0)
        #expect(GrowthHeatScale.maximum([GrowthCohort(month: "2026-10")]) == 0)
        #expect(cohorts[0].returned(within: 90) == 4)
    }

    @Test("Intensity is relative to the best cell and stays within 0…1")
    func intensity() {
        #expect(GrowthHeatScale.intensity(0.5, maximum: 0.5) == 1)
        #expect(GrowthHeatScale.intensity(0.25, maximum: 0.5) == 0.5)
        #expect(GrowthHeatScale.intensity(0, maximum: 0.5) == 0)
        #expect(GrowthHeatScale.intensity(0.9, maximum: 0.5) == 1)
        #expect(GrowthHeatScale.intensity(-0.1, maximum: 0.5) == 0)
        #expect(GrowthHeatScale.intensity(nil, maximum: 0.5) == 0)
        #expect(GrowthHeatScale.intensity(0.3, maximum: 0) == 0, "a table without returns stays pale")
    }

    @Test("Opacity grows with intensity from the faintest to the strongest tint; strong cells get white text")
    func opacity() {
        #expect(GrowthHeatScale.opacity(0) == GrowthHeatScale.minimumOpacity)
        #expect(GrowthHeatScale.opacity(1) == GrowthHeatScale.maximumOpacity)
        #expect(GrowthHeatScale.opacity(2) == GrowthHeatScale.maximumOpacity)
        #expect(GrowthHeatScale.opacity(-1) == GrowthHeatScale.minimumOpacity)
        let steps = stride(from: 0.0, through: 1.0, by: 0.25).map(GrowthHeatScale.opacity)
        #expect(zip(steps, steps.dropFirst()).allSatisfy { $0 < $1 })
        #expect(!GrowthHeatScale.prefersLightText(0.59))
        #expect(GrowthHeatScale.prefersLightText(0.6))
    }
}
