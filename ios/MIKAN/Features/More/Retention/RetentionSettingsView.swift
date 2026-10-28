import SwiftUI

/// More → «Удержание клиентов»: bonuses, the birthday greeting and discount, win-back messages and certificate validity.
/// Owner and admin change it; a master only looks.
struct RetentionSettingsView: View {
    @Environment(APIClient.self) private var api
    @Environment(\.permissions) private var permissions
    @State private var remote = Remote<RetentionSettings>()
    @State private var settings: RetentionSettings?
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var savedCount = 0

    private var isReadOnly: Bool { !permissions.editsRetention }
    private var hasChanges: Bool { settings != nil && settings != remote.value }
    private var canSave: Bool { hasChanges && settings.flatMap(RetentionRules.issue) == nil }

    var body: some View {
        Form {
            if isReadOnly {
                ReadOnlyNotice()
            }
            if let settings = Binding($settings) {
                Group {
                    LoyaltySettingsSection(loyalty: settings.loyalty)
                    BirthdaySettingsSections(birthday: settings.birthday)
                    WinbackSettingsSection(winback: settings.winback)
                    CertificateSettingsSection(certificates: settings.certificates)
                }
                .disabled(isReadOnly)
            }
        }
        .overlay {
            if settings == nil { RemoteStateOverlay(remote: remote, retry: load) }
        }
        .navigationTitle("Удержание клиентов")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !isReadOnly {
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

    private func load() async {
        let keepsLocalEdits = hasChanges
        await remote.load { try await api.retentionSettings() }
        if let value = remote.value, !keepsLocalEdits {
            settings = value
        }
    }

    private func save() {
        guard let settings else { return }
        if let issue = RetentionRules.issue(settings) {
            errorMessage = issue
            return
        }
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let saved = try await api.saveRetentionSettings(settings)
                remote.set(saved)
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
        RetentionSettingsView()
    }
    .previewEnvironment()
}
#endif
