import SwiftUI

/// «Перенести» (Titan `when.tsx`): a new day and time of going out, in the studio time zone.
struct SmmRescheduleSheet: View {
    @Environment(\.dismiss) private var dismiss

    let timeZone: TimeZone
    /// `date` — `YYYY-MM-DD`, `time` — `HH:mm`, both in the studio time zone.
    let onSave: (_ date: String, _ time: String) async throws -> Void

    private let initial: Date
    @State private var when: Date
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(publishAt: Date?, timeZone: TimeZone, onSave: @escaping (_ date: String, _ time: String) async throws -> Void) {
        self.timeZone = timeZone
        self.onSave = onSave
        let start = publishAt ?? SmmClock.tomorrowNoon(in: timeZone)
        initial = start
        _when = State(initialValue: start)
    }

    private var isChanged: Bool {
        SmmText.dayKey(of: when, in: timeZone) != SmmText.dayKey(of: initial, in: timeZone)
            || SmmText.timeKey(of: when, in: timeZone) != SmmText.timeKey(of: initial, in: timeZone)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("Выход", selection: $when, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                        .environment(\.timeZone, timeZone)
                } footer: {
                    Text("Время — по часовому поясу студии. Telegram-пост выйдет сам, остальное маркетолог передаст выкладывающему в это время.")
                }
            }
            .navigationTitle("Перенести")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Сохранить", action: save)
                            .disabled(!isChanged)
                    }
                }
            }
            .interactiveDismissDisabled(isSaving)
            .errorAlert($errorMessage, title: "Не перенеслось")
        }
        .presentationDetents([.medium, .large])
    }

    private func save() {
        let date = SmmText.dayKey(of: when, in: timeZone)
        let time = SmmText.timeKey(of: when, in: timeZone)
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                try await onSave(date, time)
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    SmmRescheduleSheet(publishAt: nil, timeZone: .current) { _, _ in }
}
#endif
