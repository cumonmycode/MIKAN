import SwiftUI

/// Sheet adding an exception to a master's schedule: a day off, a vacation or other hours on one date.
struct ScheduleExceptionEditor: View {
    @Environment(\.dismiss) private var dismiss

    let save: (ScheduleDaysBody) async throws -> Void

    @State private var draft: ScheduleExceptionDraft
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(studio: WorkdayHours, save: @escaping (ScheduleDaysBody) async throws -> Void) {
        self.save = save
        let today = Calendar.app.startOfDay(for: .now)
        _draft = State(initialValue: ScheduleExceptionDraft(day: today, hours: WorkHoursDraft(nil, studio: studio)))
    }

    private var problem: String? { draft.problem(calendar: .app) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Что", selection: $draft.kind.animation()) {
                        ForEach(ScheduleExceptionDraft.Kind.allCases) { kind in
                            Text(kind.title).tag(kind)
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                datesSection
                if draft.kind == .otherHours {
                    WorkHoursFields(draft: $draft.hours)
                }
                Section {
                    TextField(draft.kind == .vacation ? "Отпуск" : "Например: больничный", text: $draft.note)
                } header: {
                    Text("Комментарий")
                } footer: {
                    Text("Важнее недельного графика: в эти дни бот и календарь учитывают только исключение.")
                }
            }
            .navigationTitle("Исключение")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Сохранить", action: submit)
                            .disabled(problem != nil)
                    }
                }
            }
            .interactiveDismissDisabled(isSaving)
            .errorAlert($errorMessage)
        }
    }

    private var datesSection: some View {
        Section {
            DatePicker(draft.kind == .vacation ? "С" : "Дата", selection: $draft.from, displayedComponents: .date)
            if draft.kind == .vacation {
                DatePicker("По", selection: $draft.to, in: draft.from..., displayedComponents: .date)
            }
        } footer: {
            if draft.kind == .vacation {
                if let problem {
                    Text(problem).foregroundStyle(.orange)
                } else {
                    Text("Дней: \(draft.dayCount(calendar: .app))")
                }
            }
        }
        .onChange(of: draft.from) { _, from in
            if draft.to < from { draft.to = from }
        }
    }

    private func submit() {
        guard let body = draft.body(calendar: .app) else { return }
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                try await save(body)
                dismiss()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}
