import SwiftUI

/// «В лист ожидания»: puts a client on the waitlist — services (up to 5), a master or any, the dates (at most
/// 30 days) and a note. The client is told in Telegram once matching time frees up.
struct WaitlistEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    @Environment(ReferenceStore.self) private var reference

    @State private var draft = WaitlistDraft()
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var referenceError: String?
    let onCreated: (WaitlistEntry) -> Void

    private var today: Date { Calendar.app.startOfDay(for: .now) }
    private var validationMessage: String? { draft.validationMessage() }

    var body: some View {
        NavigationStack {
            Form {
                clientSection
                servicesSection
                masterSection
                datesSection
                Section {
                    TextField("Пожелания: время дня, зона, эскиз…", text: $draft.note, axis: .vertical)
                        .lineLimit(2...6)
                } header: {
                    Text("Комментарий")
                } footer: {
                    if draft.note.trimmed.count > WaitlistDraft.maxNoteLength {
                        Text("Не больше \(WaitlistDraft.maxNoteLength) символов.").foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("В лист ожидания")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Добавить") { save() }
                            .disabled(validationMessage != nil)
                    }
                }
            }
            .interactiveDismissDisabled(isSaving)
            .task { await loadReference() }
            .errorAlert($errorMessage)
        }
    }

    private var clientSection: some View {
        Section("Клиент") {
            NavigationLink {
                ClientPickerView(selection: $draft.client)
            } label: {
                if let client = draft.client {
                    HStack(spacing: 12) {
                        InitialsAvatar(name: client.fullName, size: 34)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(client.fullName).foregroundStyle(.primary)
                            if let phone = client.phone.nonEmpty {
                                Text(PhoneText.display(phone)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)
                } else {
                    Label("Выберите клиента", systemImage: "person.crop.circle.badge.plus")
                }
            }
        }
    }

    private var servicesSection: some View {
        Section {
            ForEach(draft.items, id: \.serviceId) { item in
                Text(item.title)
            }
            .onDelete { draft.remove(at: $0) }
            NavigationLink {
                WaitlistServicePickerView(draft: $draft)
            } label: {
                Label(draft.items.isEmpty ? "Выбрать услуги" : "Изменить услуги", systemImage: "list.bullet.rectangle")
            }
        } header: {
            Text("Услуги")
        } footer: {
            Text("До \(WaitlistDraft.maxItems) услуг. Сообщение придёт, когда освободится время сразу для всех.")
        }
    }

    private var masterSection: some View {
        Section {
            if reference.masters.isEmpty, referenceError == nil {
                LabeledContent("Мастер") { ProgressView() }
            } else {
                Picker("Мастер", selection: $draft.masterId) {
                    Text("Любой мастер").tag(Int?.none)
                    ForEach(reference.masters) { master in
                        Text(master.name).tag(Int?.some(master.id))
                    }
                }
            }
        } footer: {
            if let referenceError {
                Text(referenceError).foregroundStyle(.red)
            }
        }
    }

    private var datesSection: some View {
        Section {
            DatePicker("С", selection: $draft.dateFrom, in: today...lastDay, displayedComponents: .date)
            DatePicker("По", selection: $draft.dateTo, in: draft.dateFrom...lastDay, displayedComponents: .date)
        } header: {
            Text("Даты")
        } footer: {
            if let error = WaitlistRange.validate(from: draft.dateFrom, to: draft.dateTo) {
                Text(error.message).foregroundStyle(.red)
            } else {
                Text("\(WaitlistText.range(first: draft.dateFrom, last: draft.dateTo)) · \(Plural.days(WaitlistRange.days(from: draft.dateFrom, to: draft.dateTo))). Не больше \(WaitlistRange.maxDays) дней.")
            }
        }
    }

    private var lastDay: Date { WaitlistRange.lastDay(today: today) }

    private func loadReference() async {
        do {
            try await reference.ensureEmployees()
            referenceError = nil
        } catch {
            referenceError = error.userMessage
        }
    }

    private func save() {
        guard let body = draft.body() else {
            errorMessage = validationMessage
            return
        }
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                onCreated(try await api.createWaitlistEntry(body))
                dismiss()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    WaitlistEditorView { _ in }
        .previewEnvironment()
}
#endif
