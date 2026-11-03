import SwiftUI

/// «Запись»: studio calendar with «Все / Мои» modes and День / 3 дня / Неделя / Месяц scales.
struct ScheduleView: View {
    private enum Keys {
        static let mode = "schedule.mode"
        static let scale = "schedule.scale"
        static let showsCancelled = "schedule.showsCancelled"
    }

    private struct FocusKey: Hashable {
        let period: CalendarPeriod
        let masterId: Int?
    }

    @Environment(ScheduleStore.self) private var store
    @Environment(AppState.self) private var appState
    @Environment(ReferenceStore.self) private var reference
    @Environment(\.scenePhase) private var scenePhase

    @AppStorage(Keys.mode) private var mode: CalendarMode = .all
    @AppStorage(Keys.scale) private var scale: CalendarScale = .week
    @AppStorage(Keys.showsCancelled) private var showsCancelled = false

    @State private var base: CalendarPeriod
    @State private var pageOffset: Int? = 0
    @State private var pagerID = UUID()
    @State private var selectedDay = Calendar.app.startOfDay(for: .now)
    @State private var gridScroll: GridScrollState
    @State private var editorDraft: AppointmentDraft?
    @State private var hasAppeared = false

    init() {
        let saved = UserDefaults.standard.string(forKey: Keys.scale).flatMap(CalendarScale.init(rawValue:)) ?? .week
        _base = State(initialValue: .containing(.now, scale: saved))
        let nowMinute = TimeGridLayout.minuteOfDay(.now, calendar: .app)
        let startMinute = TimeGridLayout.initialScrollMinute(
            nowMinute: nowMinute,
            firstAppointmentMinute: nil,
            workdayStartMinute: WorkdayHours.standard.startMinute
        )
        _gridScroll = State(initialValue: GridScrollState(topMinute: startMinute))
    }

    private var me: Employee? { appState.employee }
    private var masterId: Int? { mode == .mine ? me?.id : store.masterFilter }
    private var currentPeriod: CalendarPeriod { base.shifted(by: pageOffset ?? 0) }
    private var needsMasterHint: Bool { mode == .mine && me?.isMaster != true }

    /// Day kept when switching scales or creating from the «+» button.
    private var anchorDay: Date {
        let period = currentPeriod
        if selectedDay >= period.visibleStart && selectedDay < period.visibleEnd { return selectedDay }
        return period.contains(.now) ? Calendar.app.startOfDay(for: .now) : period.start
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !needsMasterHint {
                    PeriodBar(title: currentPeriod.title(), step: step(by:))
                }
                masterFilterChip
                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background { AuraBackground() }
            .navigationTitle("Запись")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .overlay(alignment: .bottomTrailing) {
                if !needsMasterHint { addButton }
            }
            .navigationDestination(for: Appointment.self) { appointment in
                AppointmentDetailView(appointment: appointment)
            }
            .sheet(item: $editorDraft) { draft in
                AppointmentEditorView(draft: draft) { saved in
                    store.upsert(saved)
                    Task { await store.refreshVisible() }
                }
            }
            .onChange(of: FocusKey(period: currentPeriod, masterId: masterId), initial: true) { _, _ in
                focus(refresh: false)
            }
            .onChange(of: scale) { _, newScale in rebase(to: anchorDay, scale: newScale) }
            .onChange(of: pageOffset) { _, _ in pageChanged() }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                focus(refresh: true)
                Task { try? await reference.ensureWorkday(force: true) }
            }
            .onAppear(perform: appeared)
        }
    }

    @ViewBuilder
    private var content: some View {
        if needsMasterHint {
            ContentUnavailableView {
                Label("Вы не мастер", systemImage: "person.crop.circle.badge.questionmark")
            } description: {
                Text("В режиме «Мои записи» показываются записи, где вы — мастер. Отметьте «Мастер» в разделе «Ещё → Сотрудники» или посмотрите все записи.")
            } actions: {
                Button("Показать все записи") { mode = .all }
                    .buttonStyle(.glassProminent)
            }
        } else if base.scale == .month {
            MonthCalendarView(
                base: base,
                pageOffset: $pageOffset,
                pagerID: pagerID,
                query: query(for:),
                showsCancelled: showsCancelled,
                selectedDay: $selectedDay,
                onOpenDay: openDay
            )
        } else {
            PeriodPager(offset: $pageOffset) { index in
                let period = base.shifted(by: index)
                TimeGridPage(
                    period: period,
                    workday: reference.workday,
                    query: query(for: period),
                    isActive: index == (pageOffset ?? 0),
                    showsCancelled: showsCancelled,
                    scroll: gridScroll,
                    onCreate: create(at:),
                    onOpenDay: openDay
                )
            }
            .id(pagerID)
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button("Сегодня", action: goToToday)
        }
        ToolbarItem(placement: .principal) {
            ModePicker(mode: $mode)
        }
        if appState.badges.onlineAwaiting > 0 {
            ToolbarItem(placement: .topBarTrailing) {
                onlineBookingsLink(count: appState.badges.onlineAwaiting)
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            scaleMenu
        }
    }

    /// Online bookings waiting for confirmation: shown only while there are any.
    private func onlineBookingsLink(count: Int) -> some View {
        NavigationLink {
            OnlineBookingsView()
        } label: {
            Label("\(count)", systemImage: "clock.badge.questionmark")
                .labelStyle(.titleAndIcon)
                .monospacedDigit()
                .foregroundStyle(.orange)
        }
        .accessibilityLabel("Онлайн-записи ждут подтверждения: \(count)")
    }

    private var scaleMenu: some View {
        @Bindable var store = store
        return Menu {
            Picker("Масштаб", selection: $scale) {
                ForEach(CalendarScale.allCases) { scale in
                    Label(scale.title, systemImage: scale.symbol).tag(scale)
                }
            }
            Toggle("Показывать отменённые", systemImage: "xmark.circle", isOn: $showsCancelled)
            if mode == .all {
                Picker(selection: $store.masterFilter) {
                    Text("Все мастера").tag(Int?.none)
                    ForEach(reference.masters) { master in
                        Text(master.name).tag(Int?.some(master.id))
                    }
                } label: {
                    Label("Мастер", systemImage: "person.crop.circle")
                }
                .pickerStyle(.menu)
            }
        } label: {
            Label(scale.title, systemImage: scale.symbol)
                .labelStyle(.titleAndIcon)
        }
        .accessibilityLabel("Масштаб: \(scale.title)")
    }

    @ViewBuilder
    private var masterFilterChip: some View {
        if mode == .all, let id = store.masterFilter, let master = reference.employees.first(where: { $0.id == id }) {
            Button {
                withAnimation(.snappy) { store.masterFilter = nil }
            } label: {
                HStack(spacing: 8) {
                    Circle().fill(Color.master(master.color)).frame(width: 8, height: 8)
                    Text("Мастер: \(master.name)")
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .contentShape(.capsule)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .capsule)
            .accessibilityLabel("Фильтр по мастеру: \(master.name). Сбросить")
            .padding(.bottom, 4)
        }
    }

    private var addButton: some View {
        GlassEffectContainer {
            Button {
                create(at: AppointmentDraft.defaultStart(on: anchorDay))
            } label: {
                Image(systemName: "plus")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 58, height: 58)
                    .contentShape(.circle)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.tint(.accentColor).interactive(), in: .circle)
            .accessibilityLabel("Новая запись")
            .needsConnection()
        }
        .padding(.trailing, 20)
        .padding(.bottom, 20)
    }

    // MARK: - Navigation between periods

    private func query(for period: CalendarPeriod) -> ScheduleQuery {
        ScheduleQuery(period: period, masterId: masterId)
    }

    private func focus(refresh: Bool) {
        guard !needsMasterHint else { return }
        let period = currentPeriod
        store.focus(
            on: query(for: period),
            prefetch: [query(for: period.shifted(by: -1)), query(for: period.shifted(by: 1))],
            refresh: refresh
        )
    }

    private func appeared() {
        focus(refresh: true)
        if !hasAppeared {
            hasAppeared = true
            if base.scale != scale { rebase(to: .now, scale: scale) }
            gridScroll.scroll(toMinute: initialMinute(for: currentPeriod))
        }
        Task { try? await reference.ensureEmployees() }
        Task { try? await reference.ensureWorkday() }
    }

    private func rebase(to day: Date, scale: CalendarScale) {
        base = .containing(day, scale: scale)
        pageOffset = 0
        pagerID = UUID()
        selectedDay = Calendar.app.startOfDay(for: day)
        if scale != .month {
            gridScroll.scroll(toMinute: initialMinute(for: base))
        }
    }

    private func pageChanged() {
        let period = currentPeriod
        if !period.contains(selectedDay) {
            selectedDay = period.contains(.now) ? Calendar.app.startOfDay(for: .now) : period.start
        }
        if let offset = pageOffset, abs(offset) > PeriodPaging.range.upperBound - PeriodPaging.rebaseMargin {
            rebase(to: period.start, scale: base.scale)
        }
    }

    private func step(by delta: Int) {
        withAnimation(.smooth) { pageOffset = (pageOffset ?? 0) + delta }
    }

    private func goToToday() {
        withAnimation(.smooth) { rebase(to: .now, scale: base.scale) }
    }

    private func openDay(_ day: Date) {
        selectedDay = Calendar.app.startOfDay(for: day)
        if scale == .day {
            rebase(to: day, scale: .day)
        } else {
            scale = .day
        }
    }

    private func create(at start: Date) {
        editorDraft = AppointmentDraft.new(at: start, masterId: masterId)
    }

    private func initialMinute(for period: CalendarPeriod) -> Int {
        let now = Date.now
        let nowMinute = period.contains(now) ? TimeGridLayout.minuteOfDay(now, calendar: .app) : nil
        let first = (store.appointments(for: query(for: period)) ?? [])
            .filter(\.isActive)
            .min { $0.startsAt < $1.startsAt }
        return TimeGridLayout.initialScrollMinute(
            nowMinute: nowMinute,
            firstAppointmentMinute: first.map { TimeGridLayout.minuteOfDay($0.startsAt, calendar: .app) },
            workdayStartMinute: reference.workday.window(on: period.visibleStart, calendar: .app).lowerBound
        )
    }
}

/// Compact period header under the navigation bar: «12–18 окт.» with ‹ › to page between periods.
private struct PeriodBar: View {
    let title: String
    let step: (Int) -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text(title)
                .font(.title3.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            HStack(spacing: 8) {
                Button("Предыдущий период", systemImage: "chevron.left") { step(-1) }
                Button("Следующий период", systemImage: "chevron.right") { step(1) }
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.glass)
            .controlSize(.small)
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 2)
    }
}

/// «Все записи | Мои записи»; falls back to short labels when the bar is narrow.
private struct ModePicker: View {
    @Binding var mode: CalendarMode

    var body: some View {
        ViewThatFits(in: .horizontal) {
            picker(short: false)
            picker(short: true)
        }
    }

    private func picker(short: Bool) -> some View {
        Picker("Режим", selection: $mode) {
            ForEach(CalendarMode.allCases) { mode in
                Text(short ? mode.shortTitle : mode.title)
                    .accessibilityLabel(mode.title)
                    .tag(mode)
            }
        }
        .pickerStyle(.segmented)
        .fixedSize()
    }
}

#if DEBUG
#Preview {
    ScheduleView()
        .previewEnvironment()
}
#endif
