import SwiftUI

/// One page of the День / 3 дня / Неделя grid: day headers + vertically scrolling hours.
/// The hours run from the studio's opening to its closing time, widened to appointments outside them.
struct TimeGridPage: View {
    @Environment(ScheduleStore.self) private var store

    let period: CalendarPeriod
    let workday: WorkdayHours
    let query: ScheduleQuery
    let isActive: Bool
    let showsCancelled: Bool
    let scroll: GridScrollState
    let onCreate: (Date) -> Void
    let onOpenDay: (Date) -> Void

    @State private var position: ScrollPosition

    init(
        period: CalendarPeriod,
        workday: WorkdayHours,
        query: ScheduleQuery,
        isActive: Bool,
        showsCancelled: Bool,
        scroll: GridScrollState,
        onCreate: @escaping (Date) -> Void,
        onOpenDay: @escaping (Date) -> Void
    ) {
        self.period = period
        self.workday = workday
        self.query = query
        self.isActive = isActive
        self.showsCancelled = showsCancelled
        self.scroll = scroll
        self.onCreate = onCreate
        self.onOpenDay = onOpenDay
        // Start at the requested hour on the very first layout instead of jumping from the top.
        // Appointments are not known yet, so this is the working-hours range; `syncPosition` corrects it.
        let range = Self.visibleRange(days: period.days(), workday: workday, appointments: [])
        let startY = TimeGridLayout.y(forMinute: scroll.topMinute, hourHeight: Self.hourHeight(for: period.scale), rangeStart: range.lowerBound)
        _position = State(initialValue: ScrollPosition(y: max(0, startY)))
    }

    static func hourHeight(for scale: CalendarScale) -> CGFloat { scale == .week ? 48 : 60 }

    static func visibleRange(days: [Date], workday: WorkdayHours, appointments: [Appointment]) -> Range<Int> {
        let intervals = appointments.map { TimeGridLayout.Interval(id: $0.id, start: $0.startsAt, end: $0.endsAt) }
        return TimeGridLayout.visibleRange(
            windows: days.map { workday.window(on: $0, calendar: .app) },
            segments: days.flatMap { TimeGridLayout.segments(of: intervals, dayStart: $0, calendar: .app) }
        )
    }

    private var compact: Bool { period.scale == .week }
    private var hourHeight: CGFloat { Self.hourHeight(for: period.scale) }
    private var days: [Date] { period.days() }

    private var appointments: [Appointment] {
        let all = store.appointments(for: query) ?? []
        return showsCancelled ? all : all.filter(\.isActive)
    }

    private var range: Range<Int> { Self.visibleRange(days: days, workday: workday, appointments: appointments) }

    var body: some View {
        let range = range
        VStack(spacing: 0) {
            DayHeaderRow(days: days, scale: period.scale, isLoading: store.isLoading(query), onOpenDay: onOpenDay)
            MastersOffRow(days: days, masterId: query.masterId, scale: period.scale)
            if let error = store.error(for: query) {
                LoadErrorBanner(message: error) { await store.reload(query) }
            }
            ScrollView(.vertical) {
                TimeGridContent(
                    days: days,
                    appointments: appointments,
                    range: range,
                    workingWindows: days.map { workday.window(on: $0, calendar: .app) },
                    hourHeight: hourHeight,
                    compact: compact,
                    onCreate: onCreate
                )
                .workTimeShading(days: days, range: range, hourHeight: hourHeight, masterId: query.masterId)
                .padding(.trailing, 4)
            }
            .scrollPosition($position)
            .scrollIndicators(.hidden)
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.contentOffset.y + geometry.contentInsets.top
            } action: { _, offset in
                // Only the user's own scrolling moves the shared position; the first layout reports
                // offset 0 and must not overwrite the hour we asked the grid to open at.
                guard isActive, scroll.userScrolled else { return }
                scroll.topMinute = TimeGridLayout.minute(forY: offset, hourHeight: hourHeight, rangeStart: range.lowerBound)
            }
            .onScrollPhaseChange { _, phase in
                if isActive, phase == .interacting { scroll.userScrolled = true }
            }
            .refreshable { await store.reload(query) }
            .appointmentDragging(position: $position)
        }
        .onAppear(perform: syncPosition)
        .onChange(of: isActive) { _, active in if active { syncPosition() } }
        .onChange(of: scroll.request) { _, _ in
            withAnimation(isActive ? .smooth : nil) { syncPosition() }
        }
        .onChange(of: appointments.first?.id) { _, _ in scrollToFirstAppointmentIfNeeded() }
        // A wider or narrower range moves every hour; keep the same hour at the top.
        .onChange(of: range.lowerBound) { _, _ in syncPosition() }
    }

    private func syncPosition() {
        let y = TimeGridLayout.y(forMinute: scroll.topMinute, hourHeight: hourHeight, rangeStart: range.lowerBound)
        position.scrollTo(y: max(0, y))
    }

    /// For periods without today, open at the first appointment until the user scrolls.
    private func scrollToFirstAppointmentIfNeeded() {
        guard isActive, !scroll.userScrolled, !days.contains(where: { Calendar.app.isDateInToday($0) }) else { return }
        guard let first = appointments.min(by: { $0.startsAt < $1.startsAt }) else { return }
        let minute = TimeGridLayout.minuteOfDay(first.startsAt, calendar: .app)
        scroll.scroll(toMinute: TimeGridLayout.initialScrollMinute(
            nowMinute: nil,
            firstAppointmentMinute: minute,
            workdayStartMinute: range.lowerBound
        ))
    }
}

/// Weekday + date headers; today is highlighted in the accent color. Tapping a header opens that day.
private struct DayHeaderRow: View {
    let days: [Date]
    let scale: CalendarScale
    let isLoading: Bool
    let onOpenDay: (Date) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ZStack {
                if isLoading {
                    ProgressView().controlSize(.mini)
                }
            }
            .frame(width: TimeGridContent.gutterWidth)
            ForEach(days, id: \.self) { day in
                Button {
                    if scale != .day { onOpenDay(day) }
                } label: {
                    header(for: day)
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity)
                .accessibilityLabel(DateText.weekdayDayMonth(day))
                .accessibilityHint(scale == .day ? "" : "Открыть день")
            }
            Color.clear.frame(width: 4, height: 0)
        }
        // Keep the row at its content height; a flexible child here used to split the page's height
        // with the hour grid and leave large gaps above and below the weekday headers.
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, 6)
    }

    private func header(for day: Date) -> some View {
        let isToday = Calendar.app.isDateInToday(day)
        return VStack(spacing: 3) {
            Text(scale == .day ? DateText.weekdayDayMonth(day) : DateText.shortWeekday(day))
                .font(.caption.weight(.medium))
                .foregroundStyle(isToday ? Color.accentColor : Color.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            if scale != .day {
                Text(DateText.dayNumber(day))
                    .font(scale == .week ? .subheadline.weight(.semibold) : .title3.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(isToday ? Color.white : Color.primary)
                    .frame(minWidth: 30, minHeight: 30)
                    .background {
                        if isToday { Circle().fill(Color.accentColor) }
                    }
            }
        }
        .contentShape(.rect)
    }
}

/// Inline failure notice that keeps the grid visible.
struct LoadErrorBanner: View {
    let message: String
    let retry: () async -> Void
    @State private var isRetrying = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text(message)
                .font(.footnote)
                .lineLimit(2)
            Spacer(minLength: 4)
            Button(isRetrying ? "…" : "Повторить") {
                Task {
                    isRetrying = true
                    await retry()
                    isRetrying = false
                }
            }
            .font(.footnote.weight(.semibold))
            .disabled(isRetrying)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color.orange.opacity(0.12), in: .rect(cornerRadius: 12))
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }
}
