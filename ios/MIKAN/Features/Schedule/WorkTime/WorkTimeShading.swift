import SwiftUI

extension View {
    /// Shades the masters' non-working time under a `TimeGridContent` of `days` (see `WorkTimeShading`).
    func workTimeShading(days: [Date], range: Range<Int>, hourHeight: CGFloat, masterId: Int?) -> some View {
        background { WorkTimeShading(days: days, range: range, hourHeight: hourHeight, masterId: masterId) }
    }
}

/// Drawn under the time grid from the masters' own schedules: the time nobody of the shown masters works is shaded
/// (hatched on a day off) and, for «Все мастера», thin stripes in each master's colour run along their working hours.
/// Loads `/schedules` for its days; without own schedules it draws nothing.
struct WorkTimeShading: View {
    private struct LoadKey: Hashable {
        let dates: [String]
        let generation: Int
    }

    @Environment(WorkScheduleStore.self) private var store
    @Environment(ReferenceStore.self) private var reference

    let days: [Date]
    let range: Range<Int>
    let hourHeight: CGFloat
    let masterId: Int?

    private var dates: [String] { days.map { CalendarDay.string(from: $0) } }
    private var railWidth: CGFloat { days.count > 3 ? 2 : 3 }

    private var columns: [ScheduleShading.Column] {
        days.map { day in
            ScheduleShading.column(
                days: store.days(on: CalendarDay.string(from: day)),
                masterId: masterId,
                offset: ScheduleShading.studioOffset(of: day, calendar: .app, studioTimeZone: reference.workday.timeZone),
                studioWindow: reference.workday.window(on: day, calendar: .app)
            )
        }
    }

    private var colors: [Int: Color] {
        Dictionary(reference.employees.map { ($0.id, Color.master($0.color)) }, uniquingKeysWith: { first, _ in first })
    }

    var body: some View {
        let columns = columns
        let colors = colors
        let range = range
        let hourHeight = hourHeight
        let railWidth = railWidth
        Canvas { context, size in
            let gutter = TimeGridContent.gutterWidth
            let columnWidth = (size.width - gutter) / CGFloat(max(1, columns.count))
            func y(_ minute: Int) -> CGFloat {
                TimeGridLayout.y(forMinute: Double(min(max(minute, range.lowerBound), range.upperBound)), hourHeight: hourHeight, rangeStart: range.lowerBound)
            }
            var shade = Path()
            for (index, column) in columns.enumerated() {
                let x = gutter + CGFloat(index) * columnWidth
                for minutes in column.shaded where y(minutes.upperBound) > y(minutes.lowerBound) {
                    shade.addRect(CGRect(x: x, y: y(minutes.lowerBound), width: columnWidth, height: y(minutes.upperBound) - y(minutes.lowerBound)))
                }
                if column.isDayOff {
                    Self.hatch(&context, CGRect(x: x, y: 0, width: columnWidth, height: size.height))
                }
                let railsWidth = CGFloat(column.rails.count) * (railWidth + 1)
                for (railIndex, rail) in column.rails.enumerated() {
                    let railX = x + columnWidth - railsWidth - 1 + CGFloat(railIndex) * (railWidth + 1)
                    var stripe = Path()
                    for minutes in rail.working where y(minutes.upperBound) > y(minutes.lowerBound) {
                        stripe.addRect(CGRect(x: railX, y: y(minutes.lowerBound), width: railWidth, height: y(minutes.upperBound) - y(minutes.lowerBound)))
                    }
                    context.fill(stripe, with: .color((colors[rail.employeeId] ?? .secondary).opacity(0.55)))
                }
            }
            context.fill(shade, with: .color(.secondary.opacity(0.08)))
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .task(id: LoadKey(dates: dates, generation: store.generation)) {
            await store.ensure(dates: dates)
        }
    }

    /// Diagonal lines over a day nobody works.
    private static func hatch(_ context: inout GraphicsContext, _ rect: CGRect) {
        var lines = Path()
        let spacing: CGFloat = 10
        var offset = -rect.height
        while offset < rect.width {
            lines.move(to: CGPoint(x: rect.minX + offset, y: rect.maxY))
            lines.addLine(to: CGPoint(x: rect.minX + offset + rect.height, y: rect.minY))
            offset += spacing
        }
        context.drawLayer { layer in
            layer.clip(to: Path(rect))
            layer.stroke(lines, with: .color(.secondary.opacity(0.12)), lineWidth: 1)
        }
    }
}

/// Under the day headers: who does not work that day by their own schedule. Hidden when nobody is off.
struct MastersOffRow: View {
    @Environment(WorkScheduleStore.self) private var store
    @Environment(ReferenceStore.self) private var reference

    let days: [Date]
    let masterId: Int?
    let scale: CalendarScale

    var body: some View {
        let off = days.map { ScheduleShading.offMasters(days: store.days(on: CalendarDay.string(from: $0)), masterId: masterId) }
        if off.contains(where: { !$0.isEmpty }) {
            HStack(spacing: 0) {
                Color.clear.frame(width: TimeGridContent.gutterWidth, height: 1)
                ForEach(Array(off.enumerated()), id: \.offset) { _, masters in
                    cell(masters)
                        .frame(maxWidth: .infinity)
                }
                Color.clear.frame(width: 4, height: 1)
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.bottom, 4)
        }
    }

    private func name(_ id: Int) -> String {
        reference.employees.first { $0.id == id }?.name ?? "Мастер"
    }

    /// «Не работает: Фатима (отпуск)», «Не работают: Фатима, Борис».
    private func label(_ masters: [ScheduleDay]) -> String {
        let names = masters.map { day in name(day.employeeId) + (day.note.map { " (\($0.lowercased()))" } ?? "") }
        return "\(masters.count == 1 ? "Не работает" : "Не работают"): \(names.joined(separator: ", "))"
    }

    @ViewBuilder
    private func cell(_ masters: [ScheduleDay]) -> some View {
        if masters.isEmpty {
            Color.clear.frame(height: 1)
        } else if scale == .week {
            HStack(spacing: 2) {
                Image(systemName: "moon.zzz.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                if masterId == nil {
                    ForEach(masters.prefix(3), id: \.employeeId) { day in
                        Circle()
                            .fill(Color.master(reference.employees.first { $0.id == day.employeeId }?.color))
                            .frame(width: 6, height: 6)
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label(masters))
        } else {
            Text(masterId == nil ? label(masters) : (masters[0].note ?? "Выходной"))
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .padding(.horizontal, 4)
                .accessibilityLabel(label(masters))
        }
    }
}
