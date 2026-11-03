import CoreGraphics
import Foundation

/// A column of the time grid an appointment can be dropped into: its day and, in a grid with master columns, the
/// column's master (`nil` keeps the appointment's own master).
nonisolated struct DragColumn: Hashable, Sendable {
    let day: Date
    var masterId: Int?
}

/// The grid an appointment is dragged in, in the numbers `TimeGridContent` lays its blocks out with.
nonisolated struct DragGrid: Equatable, Sendable {
    let columns: [DragColumn]
    let columnWidth: CGFloat
    let hourHeight: CGFloat
    /// Visible minutes of the day: a drop stays inside them.
    let range: Range<Int>
}

/// Where a lifted appointment would land.
nonisolated struct DragTarget: Equatable, Sendable {
    let column: Int
    /// Minutes since the column's midnight.
    let startMinute: Int
    let startsAt: Date
    let endsAt: Date
    let masterId: Int
}

/// Who may lift what (docs/API.md «Moving an appointment in the calendar»).
nonisolated enum AppointmentDragRules {
    /// Open appointments only; a master lifts only their own. An appointment running past midnight is drawn as two
    /// blocks and is moved in the editor instead.
    static func canDrag(_ appointment: Appointment, by employee: Employee?, calendar: Calendar = .app) -> Bool {
        guard let employee, appointment.isOpen else { return false }
        if employee.role == .master, appointment.master.id != employee.id { return false }
        return calendar.isDate(appointment.startsAt, inSameDayAs: appointment.endsAt.addingTimeInterval(-1))
    }

    /// Only the owner and admins hand an appointment over to another master.
    static func canChangeMaster(by employee: Employee?) -> Bool {
        guard let employee else { return false }
        return employee.role != .master
    }
}

/// One drag: the finger's position in the grid → the new time (snapped to 15 minutes, duration kept), day and master.
nonisolated struct AppointmentDragPlan: Sendable {
    static let slotMinutes = TimeGridLayout.slotMinutes

    let appointment: Appointment
    let grid: DragGrid
    /// The block's frame when lifted (the appointment returns there).
    let sourceFrame: CGRect
    let sourceColumn: Int
    /// Where the finger lifted the block, in grid coordinates.
    let grabLocation: CGPoint
    let canChangeMaster: Bool
    private let calendar: Calendar
    private let originalMinute: Int

    /// `nil` when the grid is empty or the finger is not over the appointment's day.
    init?(
        appointment: Appointment,
        grid: DragGrid,
        sourceFrame: CGRect,
        grabLocation: CGPoint,
        canChangeMaster: Bool,
        calendar: Calendar = .app
    ) {
        guard !grid.columns.isEmpty, grid.columnWidth > 0, grid.hourHeight > 0 else { return nil }
        let source = Self.columnIndex(atX: grabLocation.x, in: grid)
        guard calendar.isDate(appointment.startsAt, inSameDayAs: grid.columns[source].day) else { return nil }
        self.appointment = appointment
        self.grid = grid
        self.sourceFrame = sourceFrame
        self.sourceColumn = source
        self.grabLocation = grabLocation
        self.canChangeMaster = canChangeMaster
        self.calendar = calendar
        self.originalMinute = TimeGridLayout.minuteOfDay(appointment.startsAt, calendar: calendar)
    }

    var durationMinutes: Int { appointment.durationMin }

    /// Where the appointment is now.
    var original: DragTarget {
        DragTarget(
            column: sourceColumn,
            startMinute: originalMinute,
            startsAt: appointment.startsAt,
            endsAt: appointment.endsAt,
            masterId: appointment.master.id
        )
    }

    /// The landing place for the finger at `location`. Less than half a slot up or down keeps the time as it is
    /// (an appointment at 14:10 moved to another day stays at 14:10); otherwise the start snaps to 15 minutes and
    /// stays inside the visible hours with the whole appointment.
    func target(at location: CGPoint) -> DragTarget {
        let column = column(atX: location.x)
        let raw = Double(originalMinute) + Double(location.y - grabLocation.y) / Double(grid.hourHeight) * 60
        let moved = abs(raw - Double(originalMinute)) >= Double(Self.slotMinutes) / 2
        if !moved, column == sourceColumn { return original }
        let minute = moved ? snapped(raw) : originalMinute
        let day = grid.columns[column].day
        let start = calendar.date(byAdding: .minute, value: minute, to: day) ?? day
        return DragTarget(
            column: column,
            startMinute: minute,
            startsAt: start,
            endsAt: start.addingTimeInterval(appointment.endsAt.timeIntervalSince(appointment.startsAt)),
            masterId: grid.columns[column].masterId ?? appointment.master.id
        )
    }

    /// The block's frame at `target`: back in its own lane when unchanged, else the column's full width.
    func frame(of target: DragTarget, inset: CGFloat = 1.5) -> CGRect {
        if target == original { return sourceFrame }
        let top = CGFloat(TimeGridLayout.y(forMinute: Double(target.startMinute), hourHeight: grid.hourHeight, rangeStart: grid.range.lowerBound))
        let minutes = max(durationMinutes, TimeGridLayout.minimumLayoutMinutes)
        let height = CGFloat(TimeGridLayout.y(forMinute: Double(minutes), hourHeight: grid.hourHeight))
        return CGRect(
            x: CGFloat(target.column) * grid.columnWidth + inset,
            y: top + inset,
            width: max(grid.columnWidth - inset * 2, 4),
            height: height - inset * 2
        )
    }

    static func columnIndex(atX x: CGFloat, in grid: DragGrid) -> Int {
        let index = Int((x / grid.columnWidth).rounded(.down))
        return min(max(0, index), grid.columns.count - 1)
    }

    /// The hovered column; another master's column only for those who may change the master.
    private func column(atX x: CGFloat) -> Int {
        let hovered = Self.columnIndex(atX: x, in: grid)
        guard let master = grid.columns[hovered].masterId, master != appointment.master.id, !canChangeMaster else {
            return hovered
        }
        return sourceColumn
    }

    private func snapped(_ minute: Double) -> Int {
        let slot = Self.slotMinutes
        let lower = grid.range.lowerBound
        let latest = grid.range.upperBound - durationMinutes
        let upper = max(lower, Int((Double(latest) / Double(slot)).rounded(.down)) * slot)
        let rounded = Int((minute / Double(slot)).rounded()) * slot
        return min(max(rounded, lower), upper)
    }
}

/// Scrolling the grid while the finger holds an appointment near its top or bottom edge.
nonisolated enum DragAutoScroll {
    /// Height of the band along each edge that scrolls.
    static let edge: CGFloat = 64
    /// Points per second with the finger at the very edge.
    static let maxSpeed: CGFloat = 700

    /// Negative near the top, positive near the bottom, faster closer to the edge, 0 elsewhere.
    /// `fingerY` is measured from the top of the visible area.
    static func velocity(fingerY: CGFloat, visibleHeight: CGFloat) -> CGFloat {
        guard visibleHeight > edge * 2 else { return 0 }
        if fingerY < edge { return -maxSpeed * min(1, (edge - fingerY) / edge) }
        let bottomBand = visibleHeight - edge
        if fingerY > bottomBand { return maxSpeed * min(1, (fingerY - bottomBand) / edge) }
        return 0
    }

    /// The offset after `seconds` at `velocity`, kept within `0…maxOffset`.
    static func offset(from offset: CGFloat, velocity: CGFloat, seconds: Double, maxOffset: CGFloat) -> CGFloat {
        min(max(0, offset + velocity * seconds), max(0, maxOffset))
    }
}
