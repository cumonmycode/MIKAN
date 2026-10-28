import SwiftUI

/// Form rows for the hours of one day: start, end and the breaks, with the reason when the server would refuse them.
struct WorkHoursFields: View {
    @Binding var draft: WorkHoursDraft

    var body: some View {
        Section {
            timePicker("Начало", selection: $draft.start, options: WorkHoursDraft.startOptions)
            timePicker("Конец", selection: $draft.end, options: WorkHoursDraft.endOptions)
        } header: {
            Text("Часы работы")
        } footer: {
            if let problem = draft.problem {
                Label(problem, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
            }
        }
        Section {
            ForEach($draft.breaks) { $pause in
                VStack(alignment: .leading, spacing: 4) {
                    timePicker("Перерыв с", selection: $pause.start, options: WorkHoursDraft.startOptions)
                    timePicker("до", selection: $pause.end, options: WorkHoursDraft.endOptions)
                }
            }
            .onDelete { draft.breaks.remove(atOffsets: $0) }
            if draft.canAddBreak {
                Button("Добавить перерыв", systemImage: "cup.and.saucer") {
                    withAnimation { draft.addBreak() }
                }
            }
        } header: {
            Text("Перерывы")
        } footer: {
            Text(draft.breaks.isEmpty
                ? "В перерыв бот не предлагает время, а запись на него приложение попросит подтвердить."
                : "Смахните перерыв влево, чтобы удалить.")
        }
    }

    private func timePicker(_ title: String, selection: Binding<Int>, options: [Int]) -> some View {
        Picker(title, selection: selection) {
            ForEach(Self.including(selection.wrappedValue, in: options), id: \.self) { minute in
                Text(WorkdayHours.text(fromMinute: minute)).tag(minute)
            }
        }
        .monospacedDigit()
    }

    /// The picker's options plus the current value when it falls between steps (hours typed on another device).
    private static func including(_ value: Int, in options: [Int]) -> [Int] {
        options.contains(value) ? options : (options + [value]).sorted()
    }
}

/// Sheet for one weekday of the weekly schedule: a working day with its hours, or a day off.
struct WorkDaySheet: View {
    @Environment(\.dismiss) private var dismiss

    let title: String
    let save: (WorkHours?) async throws -> Void

    @State private var isWorking: Bool
    @State private var draft: WorkHoursDraft
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(title: String, hours: WorkHours?, studio: WorkdayHours, save: @escaping (WorkHours?) async throws -> Void) {
        self.title = title
        self.save = save
        _isWorking = State(initialValue: hours != nil)
        _draft = State(initialValue: WorkHoursDraft(hours, studio: studio))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Рабочий день", isOn: $isWorking.animation())
                } footer: {
                    if !isWorking {
                        Text("В выходной бот не предлагает время этого мастера.")
                    }
                }
                if isWorking {
                    WorkHoursFields(draft: $draft)
                }
            }
            .navigationTitle(title)
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
                            .disabled(isWorking && draft.problem != nil)
                    }
                }
            }
            .interactiveDismissDisabled(isSaving)
            .errorAlert($errorMessage)
        }
    }

    private func submit() {
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                try await save(isWorking ? draft.hours : nil)
                dismiss()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}
