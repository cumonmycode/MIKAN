import SwiftUI

struct StudioSettingsView: View {
    @Environment(APIClient.self) private var api
    @Environment(ReferenceStore.self) private var reference
    @Environment(\.permissions) private var permissions
    @State private var remote = Remote<StudioSettings>()
    @State private var settings: StudioSettings?
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var savedCount = 0

    /// Common Russian time zones.
    static let timeZones: [(id: String, title: String)] = [
        ("Europe/Kaliningrad", "Калининград (UTC+2)"),
        ("Europe/Moscow", "Москва (UTC+3)"),
        ("Europe/Samara", "Самара (UTC+4)"),
        ("Asia/Yekaterinburg", "Екатеринбург (UTC+5)"),
        ("Asia/Omsk", "Омск (UTC+6)"),
        ("Asia/Novosibirsk", "Новосибирск (UTC+7)"),
        ("Asia/Tomsk", "Томск (UTC+7)"),
        ("Asia/Krasnoyarsk", "Красноярск (UTC+7)"),
        ("Asia/Irkutsk", "Иркутск (UTC+8)"),
        ("Asia/Yakutsk", "Якутск (UTC+9)"),
        ("Asia/Vladivostok", "Владивосток (UTC+10)"),
        ("Asia/Magadan", "Магадан (UTC+11)"),
        ("Asia/Kamchatka", "Камчатка (UTC+12)"),
    ]

    private static let openingBounds = 0...(23 * 60 + 30)
    private static let closingBounds = 30...TimeGridLayout.minutesPerDay

    private var hasChanges: Bool { settings != nil && settings != remote.value }
    private var reviewLinksIssue: String? { settings?.reviewLinks.flatMap(ReviewLinksRules.issue) }
    private var onlineBookingIssue: String? { settings?.onlineBooking.flatMap(OnlineBookingRules.issue) }
    private var canSave: Bool { hasChanges && hasValidHours && reviewLinksIssue == nil && onlineBookingIssue == nil }
    /// A master only looks at the settings; the booking link stays open to everyone.
    private var isReadOnly: Bool { !permissions.editsSettings }
    private var hasValidHours: Bool {
        guard let settings else { return false }
        return WorkdayHours(start: settings.workdayStart, end: settings.workdayEnd, timeZoneIdentifier: settings.timezone) != nil
    }

    var body: some View {
        Form {
            if isReadOnly {
                ReadOnlyNotice()
            }
            if let settings = Binding($settings) {
                Section("Студия") {
                    TextField("Название", text: settings.name)
                    TextField("Адрес", text: settings.address, axis: .vertical)
                    TextField("Телефон", text: settings.phone)
                        .keyboardType(.phonePad)
                }
                .disabled(isReadOnly)
                workdaySection(settings)
                    .disabled(isReadOnly)
                Section("Онлайн") {
                    TextField("Instagram", text: settings.instagram)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Сайт", text: settings.website)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                .disabled(isReadOnly)
                Section {
                    TextField("Пара слов о студии, мастерах, стиле", text: settings.about, axis: .vertical)
                        .lineLimit(3...10)
                } header: {
                    Text("О студии")
                } footer: {
                    Text("Эти сведения бот использует в ответах клиентам.")
                }
                .disabled(isReadOnly)
                // Only on servers that know them (older ones omit the fields).
                if let rules = Binding(settings.cancellation) {
                    CancellationRulesSection(rules: rules)
                        .disabled(isReadOnly)
                }
                if let pos = Binding(settings.pos) {
                    PosSettingsSection(settings: pos)
                        .disabled(isReadOnly)
                }
                if let links = Binding(settings.reviewLinks) {
                    ReviewLinksSection(links: links)
                        .disabled(isReadOnly)
                }
                if let online = Binding(settings.onlineBooking) {
                    OnlineBookingSection(settings: online)
                        .disabled(isReadOnly)
                    BookingLinkSection(isEnabled: online.wrappedValue.enabled)
                }
                Section {
                    Picker("Часовой пояс", selection: settings.timezone) {
                        ForEach(timeZoneOptions(current: settings.wrappedValue.timezone), id: \.id) { zone in
                            Text(zone.title).tag(zone.id)
                        }
                    }
                } footer: {
                    Text("По нему считаются дни в отчётах и время отправки памяток.")
                }
                .disabled(isReadOnly)
            }
        }
        .overlay {
            if settings == nil { RemoteStateOverlay(remote: remote, retry: load) }
        }
        .navigationTitle("Настройки студии")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if permissions.editsSettings {
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving { ProgressView() } else { Button("Сохранить", action: save).disabled(!canSave) }
                }
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .remoteErrorAlert(remote)
        .errorAlert($errorMessage)
        .sensoryFeedback(.success, trigger: savedCount)
    }

    private func workdaySection(_ settings: Binding<StudioSettings>) -> some View {
        Section {
            Picker("Открытие", selection: settings.workdayStart) {
                ForEach(WorkdayHours.timeOptions(in: Self.openingBounds, including: settings.wrappedValue.workdayStart), id: \.self) { time in
                    Text(time).tag(time)
                }
            }
            Picker("Закрытие", selection: settings.workdayEnd) {
                ForEach(WorkdayHours.timeOptions(in: Self.closingBounds, including: settings.wrappedValue.workdayEnd), id: \.self) { time in
                    Text(time).tag(time)
                }
            }
            TextField("Часы работы для клиентов", text: settings.workingHours, axis: .vertical)
        } header: {
            Text("Рабочее время")
        } footer: {
            if hasValidHours {
                Text("С этого времени начинается и в это время заканчивается календарь записи. Записать клиента можно и раньше, и позже — такие записи календарь тоже покажет. Текст «Часы работы для клиентов» бот называет клиентам.")
            } else {
                Text("Закрытие должно быть позже открытия.").foregroundStyle(.red)
            }
        }
        .monospacedDigit()
    }

    private func timeZoneOptions(current: String) -> [(id: String, title: String)] {
        guard !Self.timeZones.contains(where: { $0.id == current }), !current.isEmpty else { return Self.timeZones }
        return Self.timeZones + [(current, current)]
    }

    private func load() async {
        let keepsLocalEdits = hasChanges
        await remote.load { try await api.studioSettings() }
        if let value = remote.value {
            reference.applyStudioSettings(value)
            if !keepsLocalEdits { settings = value }
        }
    }

    private func save() {
        guard let settings else { return }
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let saved = try await api.saveStudioSettings(settings)
                remote.set(saved)
                reference.applyStudioSettings(saved)
                self.settings = saved
                savedCount += 1
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        StudioSettingsView()
    }
    .previewEnvironment()
}
#endif
