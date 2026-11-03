import SwiftUI

/// Under the time of an appointment: the chosen master's own schedule that day («Фатима работает 12:00–21:00,
/// перерыв 15:00–15:30»), orange when the time is outside it. Nothing for masters without an own schedule.
struct MasterDayHint: View {
    private struct LoadKey: Hashable {
        let date: String
        let generation: Int
    }

    @Environment(WorkScheduleStore.self) private var store
    @Environment(ReferenceStore.self) private var reference

    let masterId: Int?
    let start: Date
    let end: Date

    private var date: String { CalendarDay.string(from: start) }

    var body: some View {
        Group {
            if let masterId, let day = store.day(employeeId: masterId, date: date), day.isOwn {
                let name = reference.employees.first { $0.id == masterId }?.name ?? "Мастер"
                let fits = ScheduleShading.fits(day, start: start, end: end, calendar: .app, studioTimeZone: reference.workday.timeZone)
                Label(WorkTimeText.masterDay(day, name: name), systemImage: fits ? "person.badge.clock" : "exclamationmark.triangle")
                    .foregroundStyle(fits ? Color.secondary : Color.orange)
            } else {
                Color.clear.frame(height: 0)
            }
        }
        .task(id: LoadKey(date: date, generation: store.generation)) {
            await store.ensure(dates: [date])
        }
    }
}

nonisolated extension ScheduleShading {
    /// Whether `start…end` lies inside one working interval of the master's day (shown in `calendar`'s day of `start`).
    static func fits(_ day: ScheduleDay, start: Date, end: Date, calendar: Calendar, studioTimeZone: TimeZone) -> Bool {
        let localDay = calendar.startOfDay(for: start)
        let offset = studioOffset(of: localDay, calendar: calendar, studioTimeZone: studioTimeZone)
        let first = Int((start.timeIntervalSince(localDay) / 60).rounded(.down))
        let last = Int((end.timeIntervalSince(localDay) / 60).rounded(.up))
        return workingMinutes(day, offset: offset).contains { $0.lowerBound <= first && last <= $0.upperBound }
    }
}
