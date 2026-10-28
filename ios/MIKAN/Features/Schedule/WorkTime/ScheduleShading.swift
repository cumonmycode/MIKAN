import Foundation

/// Pure geometry of the masters' working time in the calendar: minutes since a day column's local midnight.
/// A studio date is shown in the local day with the same number (like `WorkdayHours.window`), so a phone in another
/// time zone sees the hours shifted.
nonisolated enum ScheduleShading {
    /// What one day column shows.
    struct Column: Equatable, Sendable {
        /// Nobody of the shown masters works then: shaded. Only inside the studio hours — the grid already shades the rest.
        var shaded: [Range<Int>] = []
        /// None of the shown masters works this day at all (they have an own schedule and are off).
        var isDayOff = false
        /// Each master's working minutes for the thin stripes of «Все мастера»; empty when one master is shown.
        var rails: [Rail] = []
    }

    struct Rail: Equatable, Sendable {
        let employeeId: Int
        let working: [Range<Int>]
    }

    /// Minutes from the local midnight `localDay` to the studio's midnight of the same date number.
    static func studioOffset(of localDay: Date, calendar: Calendar, studioTimeZone: TimeZone) -> Int {
        var studioCalendar = calendar
        studioCalendar.timeZone = studioTimeZone
        var parts = calendar.dateComponents([.year, .month, .day], from: localDay)
        parts.hour = 0
        parts.minute = 0
        guard let studioMidnight = studioCalendar.date(from: parts) else { return 0 }
        return Int((studioMidnight.timeIntervalSince(localDay) / 60).rounded())
    }

    /// The working time of a schedule day minus its breaks, in studio minutes since midnight (empty on a day off).
    static func workingMinutes(_ day: ScheduleDay) -> [Range<Int>] {
        guard day.working,
              let start = day.start.flatMap(WorkdayHours.minute(from:)),
              let end = day.end.flatMap(WorkdayHours.minute(from:)),
              start < end
        else { return [] }
        let pauses = day.breaks
            .compactMap { b -> Range<Int>? in
                guard let s = WorkdayHours.minute(from: b.start), let e = WorkdayHours.minute(from: b.end), s < e else { return nil }
                return s..<e
            }
        return gaps(in: start..<end, covered: pauses)
    }

    /// `workingMinutes` moved into the local day column and clipped to it.
    static func workingMinutes(_ day: ScheduleDay, offset: Int) -> [Range<Int>] {
        workingMinutes(day).compactMap { range in
            let lower = min(max(0, range.lowerBound + offset), TimeGridLayout.minutesPerDay)
            let upper = min(max(lower, range.upperBound + offset), TimeGridLayout.minutesPerDay)
            return lower < upper ? lower..<upper : nil
        }
    }

    /// Sorted, merged ranges (touching ones join).
    static func union(_ ranges: [Range<Int>]) -> [Range<Int>] {
        var merged: [Range<Int>] = []
        for range in ranges.filter({ !$0.isEmpty }).sorted(by: { $0.lowerBound < $1.lowerBound }) {
            if let last = merged.last, range.lowerBound <= last.upperBound {
                merged[merged.count - 1] = last.lowerBound..<max(last.upperBound, range.upperBound)
            } else {
                merged.append(range)
            }
        }
        return merged
    }

    /// Parts of `bounds` not covered by `covered`.
    static func gaps(in bounds: Range<Int>, covered: [Range<Int>]) -> [Range<Int>] {
        var result: [Range<Int>] = []
        var cursor = bounds.lowerBound
        for range in union(covered) {
            let lower = max(range.lowerBound, bounds.lowerBound)
            let upper = min(range.upperBound, bounds.upperBound)
            guard lower < upper else { continue }
            if lower > cursor { result.append(cursor..<lower) }
            cursor = max(cursor, upper)
        }
        if cursor < bounds.upperBound { result.append(cursor..<bounds.upperBound) }
        return result
    }

    /// One day column: `days` are every master's schedule of that date, `masterId` the master shown (nil = all),
    /// `studioWindow` the studio hours of the column.
    static func column(days: [ScheduleDay], masterId: Int?, offset: Int, studioWindow: Range<Int>) -> Column {
        let shown = masterId.map { id in days.filter { $0.employeeId == id } } ?? days
        // Without own schedules everyone works the studio hours, which the grid shades already.
        guard shown.contains(where: \.isOwn) else { return Column() }
        let perMaster = shown.map { Rail(employeeId: $0.employeeId, working: workingMinutes($0, offset: offset)) }
        let working = union(perMaster.flatMap(\.working))
        return Column(
            shaded: gaps(in: studioWindow, covered: working),
            isDayOff: working.isEmpty,
            rails: masterId == nil && shown.count > 1 ? perMaster : []
        )
    }

    /// The masters (of the shown ones) who do not work that day by their own schedule.
    static func offMasters(days: [ScheduleDay], masterId: Int?) -> [ScheduleDay] {
        days.filter { (masterId == nil || $0.employeeId == masterId) && $0.isOwn && !$0.working }
    }
}
