import SwiftUI

/// An own date of the profile (Titan `date.tsx`): the studio's birthday, a guest spot, an anniversary — or the author's
/// own occasions. The marketer puts themed posts on it the same way as on holidays. Every year or once.
struct SmmOwnDateSheet: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    let profile: SmmProfile
    let brand: String
    let onAdded: (SmmKnowledge) -> Void

    @State private var title = ""
    @State private var note = ""
    @State private var day = Date.now
    @State private var isYearly = true
    @State private var isSaving = false
    @State private var errorMessage: String?

    /// `server/src/routes/smm-knowledge.ts`: title 2–120, note up to 300.
    private static let titleRange = 2...120
    private static let noteLimit = 300

    private var canSave: Bool { !isSaving && Self.titleRange.contains(title.trimmed.count) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(profile == .author ? "Например, «День рождения \(brand)»" : "Например, «День рождения студии»", text: $title)
                        .onChange(of: title) { _, value in
                            if value.count > Self.titleRange.upperBound { title = String(value.prefix(Self.titleRange.upperBound)) }
                        }
                    TextField("Что важно сказать (необязательно)", text: $note, axis: .vertical)
                        .lineLimit(2...5)
                        .onChange(of: note) { _, value in
                            if value.count > Self.noteLimit { note = String(value.prefix(Self.noteLimit)) }
                        }
                } header: {
                    Text("Что за дата")
                } footer: {
                    Text("Маркетолог поставит на этот день тематический пост и сторис, а если повод продающий — расскажет о нём заранее.")
                }
                Section {
                    DatePicker("День", selection: $day, displayedComponents: .date)
                        .environment(\.locale, .app)
                    Toggle("Каждый год", isOn: $isYearly)
                }
            }
            .disabled(isSaving)
            .navigationTitle("Своя дата")
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
                        Button("Добавить", action: save)
                            .disabled(!canSave)
                    }
                }
            }
            .interactiveDismissDisabled(isSaving)
            .errorAlert($errorMessage, title: "Не сохранилось")
        }
    }

    /// `MM-DD` every year or `YYYY-MM-DD` once, from the day picked on this phone.
    private var dayKey: String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: day)
        let monthDay = String(format: "%02d-%02d", parts.month ?? 1, parts.day ?? 1)
        return isYearly ? monthDay : String(format: "%04d-", parts.year ?? 1970) + monthDay
    }

    private func save() {
        let day = dayKey
        let title = title.trimmed
        let note = note.trimmed
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let knowledge = try await api.addSmmDate(profile, day: day, title: title, note: note)
                onAdded(knowledge)
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}
