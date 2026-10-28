#if DEBUG
import Foundation

/// A growth report for previews: a month of a busy studio.
extension PreviewData {
    private static func monthKey(_ offset: Int) -> String {
        let date = Calendar.app.date(byAdding: .month, value: offset, to: today) ?? today
        let parts = Calendar.app.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", parts.year ?? 0, parts.month ?? 0)
    }

    private static func week(working: [Int], booked: [Int]) -> [GrowthWeekdayLoad] {
        (1...7).map { GrowthWeekdayLoad(weekday: $0, workingMinutes: working[$0 - 1], bookedMinutes: booked[$0 - 1]) }
    }

    static let growth = ReportGrowth(
        from: Calendar.app.date(byAdding: .day, value: -29, to: today) ?? today,
        to: Calendar.app.date(byAdding: .day, value: 1, to: today) ?? now,
        funnel: GrowthFunnel(
            bookingRequests: GrowthRequests(created: 12, processed: 9, rejected: 2, open: 1),
            online: GrowthOnline(
                created: 20, byChannel: ["bot": 8, "miniapp": 7, "web": 5], confirmed: 15, rejected: 2, expired: 1,
                cancelledByClient: 1, completed: 11, awaiting: 1
            ),
            appointments: GrowthAppointments(
                created: 80, byChannel: ["app": 60, "bot": 8, "miniapp": 7, "web": 5], completed: 62, cancelled: 9, noShow: 3
            )
        ),
        load: [
            GrowthMasterLoad(
                employee: anna.ref, workingMinutes: 9600, bookedMinutes: 6240, completedMinutes: 5400, loadPercent: 65,
                byWeekday: week(working: [1920, 1920, 1920, 1920, 1920, 0, 0], booked: [900, 1300, 1500, 1240, 1300, 0, 0])
            ),
            GrowthMasterLoad(
                employee: oleg.ref, workingMinutes: 18_000, bookedMinutes: 7200, completedMinutes: 6600, loadPercent: 40,
                byWeekday: week(working: Array(repeating: 2571, count: 7), booked: [600, 800, 900, 1000, 1300, 1500, 1100])
            ),
        ],
        retention: GrowthRetention(
            newClients: 14, returnedWithin90Days: 5, repeatRatePercent: 35.7, averageDaysBetweenVisits: 74,
            cohorts: (0..<12).map { index in
                let clients = [30, 22, 18, 25, 27, 19, 31, 24, 28, 20, 26, 14][index]
                let age = 11 - index
                return GrowthCohort(
                    month: monthKey(-age), clients: clients,
                    returned30: age >= 1 ? clients / 6 : clients / 10,
                    returned90: age >= 3 ? clients / 3 : clients / 5,
                    returned180: age >= 6 ? clients * 2 / 5 : clients / 4
                )
            }
        ),
        value: GrowthValue(clientsWithVisits: 610, averageRevenuePerClient: 5300, averageVisitsPerClient: 2.1, top10PercentShare: 38.5),
        sources: [
            GrowthSource(source: "instagram", newClients: 6, revenue: 42_000),
            GrowthSource(source: "рекомендация", newClients: 4, revenue: 31_000),
            GrowthSource(source: "не указан", newClients: 3, revenue: 9000),
            GrowthSource(source: "онлайн-запись", newClients: 1, revenue: 3500),
        ]
    )
}
#endif
