import SwiftUI

/// «График работы» of one employee: the weekly schedule and the exceptions (days off, vacations, other hours).
/// Owners and administrators change it; everyone else sees it read-only.
struct WorkScheduleView: View {
    private struct EditedDay: Identifiable {
        let index: Int
        var id: Int { index }
    }

    @Environment(APIClient.self) private var api
    @Environment(AppState.self) private var appState
    @Environment(ReferenceStore.self) private var reference
    @Environment(WorkScheduleStore.self) private var calendarSchedules

    let employee: Employee

    @State private var schedule = Remote<WorkSchedule>()
    @State private var editedDay: EditedDay?
    @State private var addsException = false
    @State private var confirmsStudioHours = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var canEdit: Bool { appState.employee.map { $0.role == .owner || $0.role == .admin } ?? false }

    var body: some View {
        List {
            if let value = schedule.value {
                weekSection(value)
                exceptionsSection(value)
            }
        }
        .overlay { RemoteStateOverlay(remote: schedule, retry: load) }
        .refreshable { await load() }
        .task { await load() }
        .remoteErrorAlert(schedule)
        .errorAlert($errorMessage)
        .navigationTitle("График работы")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $editedDay) { day in
            WorkDaySheet(
                title: WorkTimeText.weekdays[day.index],
                hours: schedule.value?.weekly?[day.index],
                studio: reference.workday
            ) { hours in
                guard var weekly = schedule.value?.weekly else { return }
                weekly[day.index] = hours
                try await saveWeekly(weekly)
            }
        }
        .sheet(isPresented: $addsException) {
            ScheduleExceptionEditor(studio: reference.workday) { body in
                apply(try await api.setScheduleDays(employeeId: employee.id, body))
            }
        }
        .confirmationDialog("Работать в часы студии?", isPresented: $confirmsStudioHours, titleVisibility: .visible) {
            Button("Убрать свой график", role: .destructive) { run { try await saveWeekly(nil) } }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Недельный график удалится, \(employee.name) будет работать \(studioHoursText). Исключения останутся.")
        }
        .task { try? await reference.ensureWorkday() }
    }

    private var studioHoursText: String { "каждый день \(reference.workday.title)" }

    // MARK: - Sections

    @ViewBuilder
    private func weekSection(_ value: WorkSchedule) -> some View {
        Section {
            if canEdit {
                Toggle("Свой график", isOn: ownScheduleBinding(value))
                    .disabled(isSaving)
            }
            if let weekly = value.weekly, weekly.count == 7 {
                ForEach(0..<7, id: \.self) { index in
                    weekdayRow(index: index, hours: weekly[index])
                }
            } else if !canEdit {
                LabeledContent("Каждый день", value: reference.workday.title)
            }
        } header: {
            Text("Неделя")
        } footer: {
            Text(value.weekly == nil
                ? "Без своего графика \(employee.name) работает в часы студии: \(studioHoursText)."
                : "Бот предлагает клиентам только рабочее время мастера. Запись вне графика приложение сохранит после подтверждения.")
        }
    }

    @ViewBuilder
    private func weekdayRow(index: Int, hours: WorkHours?) -> some View {
        let row = LabeledContent(WorkTimeText.weekdays[index]) {
            Text(WorkTimeText.hours(hours))
                .foregroundStyle(hours == nil ? Color.secondary : Color.primary)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
        }
        if canEdit {
            Button {
                editedDay = EditedDay(index: index)
            } label: {
                row.contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(isSaving)
            .accessibilityHint("Изменить часы")
        } else {
            row
        }
    }

    @ViewBuilder
    private func exceptionsSection(_ value: WorkSchedule) -> some View {
        let groups = ScheduleExceptionGroup.groups(value.days)
        Section {
            if groups.isEmpty {
                Text("Нет выходных и отпусков впереди")
                    .foregroundStyle(.secondary)
            }
            ForEach(groups) { group in
                exceptionRow(group)
                    .swipeActions {
                        if canEdit {
                            Button("Удалить", systemImage: "trash", role: .destructive) { delete(group) }
                        }
                    }
            }
            if canEdit {
                Button("Добавить выходной или отпуск", systemImage: "plus") { addsException = true }
                    .disabled(isSaving)
            }
        } header: {
            Text("Исключения")
        } footer: {
            if canEdit, !groups.isEmpty {
                Text("Смахните исключение влево, чтобы удалить.")
            }
        }
    }

    private func exceptionRow(_ group: ScheduleExceptionGroup) -> some View {
        HStack(spacing: 12) {
            Image(systemName: group.off ? "moon.zzz" : "clock.badge")
                .foregroundStyle(group.off ? Color.secondary : Color.accentColor)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(group.title).font(.headline)
                Text([group.detail, group.note].compactMap { $0 }.joined(separator: " · "))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: - Actions

    private func ownScheduleBinding(_ value: WorkSchedule) -> Binding<Bool> {
        Binding(
            get: { value.weekly != nil },
            set: { isOn in
                if isOn {
                    let hours = WorkHoursDraft(nil, studio: reference.workday).hours
                    run { try await saveWeekly(Array(repeating: hours, count: 7)) }
                } else {
                    confirmsStudioHours = true
                }
            }
        )
    }

    private func load() async {
        await schedule.load { try await api.workSchedule(employeeId: employee.id) }
    }

    private func saveWeekly(_ weekly: [WorkHours?]?) async throws {
        apply(try await api.saveWeeklySchedule(employeeId: employee.id, weekly: weekly))
    }

    private func delete(_ group: ScheduleExceptionGroup) {
        run { apply(try await api.deleteScheduleDays(employeeId: employee.id, from: group.from, to: group.to)) }
    }

    /// Shows the saved schedule and lets the calendar fetch the masters' time again.
    private func apply(_ saved: WorkSchedule) {
        schedule.set(saved)
        calendarSchedules.invalidate()
    }

    private func run(_ operation: @escaping () async throws -> Void) {
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                try await operation()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

/// «График работы» row in the employee editor (one-line hook): opens the schedule of an existing employee.
struct WorkScheduleLinkSection: View {
    let employee: Employee

    var body: some View {
        Section {
            NavigationLink {
                WorkScheduleView(employee: employee)
            } label: {
                Label("График работы", systemImage: "calendar.badge.clock")
            }
        } footer: {
            Text("Рабочие дни, часы, перерывы, выходные и отпуск. Бот и календарь учитывают график.")
        }
    }
}

/// «Мой график» in «Ещё» for masters (one-line hook).
struct MyScheduleLink: View {
    let employee: Employee

    var body: some View {
        if employee.isMaster {
            NavigationLink {
                WorkScheduleView(employee: employee)
            } label: {
                Label("Мой график", systemImage: "calendar.badge.clock")
            }
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        WorkScheduleView(employee: PreviewData.anna)
    }
    .previewEnvironment()
}
#endif
