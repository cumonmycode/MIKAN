import SwiftUI

struct BotSettingsView: View {
    @Environment(APIClient.self) private var api
    @Environment(\.permissions) private var permissions
    @State private var remote = Remote<BotSettings>()
    @State private var settings: BotSettings?
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var savedCount = 0
    @State private var staffCode: StaffCode?
    @State private var isRequestingCode = false

    private var hasChanges: Bool { settings != nil && settings != remote.value }
    private var canSave: Bool { hasChanges && settings?.reminderIssue == nil }

    var body: some View {
        Form {
            if !permissions.editsSettings {
                ReadOnlyNotice(text: "Настройки бота меняют владелец и администратор. Рабочий чат может подключить любой сотрудник.")
            }
            if let settings = Binding($settings) {
                statusSection(settings.wrappedValue)
                Group {
                    behaviourSection(settings)
                    ReminderScheduleSection(
                        isEnabled: settings.remindersEnabled,
                        schedule: settings.reminderSchedule,
                        supportsSeveral: settings.wrappedValue.supportsReminderOffsets
                    )
                    if settings.wrappedValue.supportsStaffDigests {
                        StaffDigestSection(settings: settings)
                    }
                    messagesSection(settings)
                }
                .disabled(!permissions.editsSettings)
                staffChatSection(settings.wrappedValue)
                StaffBotSection()
            }
        }
        .overlay {
            if settings == nil { RemoteStateOverlay(remote: remote, retry: load) }
        }
        .navigationTitle("Настройки бота")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if permissions.editsSettings {
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Сохранить", action: save).disabled(!canSave)
                    }
                }
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .remoteErrorAlert(remote)
        .errorAlert($errorMessage)
        .sensoryFeedback(.success, trigger: savedCount)
        .sheet(item: Binding(get: { staffCode.map(IdentifiedStaffCode.init) }, set: { staffCode = $0?.code })) { item in
            StaffCodeSheet(code: item.code)
        }
    }

    private func statusSection(_ settings: BotSettings) -> some View {
        Section("Состояние") {
            if let username = settings.botUsername.nonEmpty, let url = URL(string: "https://t.me/\(username)") {
                NavigationLink {
                    BotLinkView(username: username, url: url)
                } label: {
                    LabeledContent("Бот", value: "@\(username)")
                }
            } else {
                LabeledContent("Бот", value: "Не подключён")
            }
            statusRow("ИИ настроен", isOn: settings.aiConfigured)
            statusRow("Рабочий чат привязан", isOn: settings.staffChatBound)
        }
    }

    private func statusRow(_ title: String, isOn: Bool) -> some View {
        LabeledContent(title) {
            Image(systemName: isOn ? "checkmark.circle.fill" : "xmark.circle.fill")
                .foregroundStyle(isOn ? Color.green : Color.red)
                .accessibilityLabel(isOn ? "Да" : "Нет")
        }
    }

    private func behaviourSection(_ settings: Binding<BotSettings>) -> some View {
        Section {
            Toggle("Бот включён", isOn: settings.enabled)
            Toggle("Отвечает ИИ", isOn: settings.aiEnabled)
            Picker("Памятки по уходу в", selection: settings.aftercareHour) {
                ForEach(0..<24, id: \.self) { hour in
                    Text(String(format: "%02d:00", hour)).tag(hour)
                }
            }
        } header: {
            Text("Поведение")
        } footer: {
            Text("Сообщения ухода со второго дня приходят в указанное время по часовому поясу студии.")
        }
    }

    private func messagesSection(_ settings: Binding<BotSettings>) -> some View {
        Group {
            Section {
                TextField("Здравствуйте! Я помощник MIKAN STUDIO…", text: settings.greeting, axis: .vertical)
                    .lineLimit(3...8)
            } header: {
                Text("Приветствие")
            } footer: {
                Text("Первое сообщение, которое клиент получает после /start.")
            }
            Section {
                TextField("Например: всегда предлагай записаться на консультацию", text: settings.extraInstructions, axis: .vertical)
                    .lineLimit(3...10)
            } header: {
                Text("Дополнительные инструкции для ИИ")
            }
        }
    }

    private func staffChatSection(_ settings: BotSettings) -> some View {
        Section {
            Button {
                requestStaffCode()
            } label: {
                HStack {
                    Label(settings.staffChatBound ? "Привязать другой рабочий чат" : "Подключить рабочий чат", systemImage: "person.3.sequence")
                    if isRequestingCode {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(isRequestingCode)
        } footer: {
            Text("В рабочий чат Telegram бот присылает новые заявки и вопросы, на которые нужен ответ сотрудника.")
        }
    }

    private func load() async {
        let keepsLocalEdits = hasChanges
        await remote.load { try await api.botSettings() }
        if let value = remote.value, !keepsLocalEdits {
            settings = value
        }
    }

    private func save() {
        guard let settings else { return }
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let saved = try await api.saveBotSettings(settings)
                remote.set(saved)
                self.settings = saved
                savedCount += 1
            } catch {
                errorMessage = error.userMessage
            }
        }
    }

    private func requestStaffCode() {
        isRequestingCode = true
        Task {
            defer { isRequestingCode = false }
            do {
                staffCode = try await api.staffCode()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        BotSettingsView()
    }
    .previewEnvironment()
}
#endif
