import SwiftUI

/// Creates a campaign (saved as a draft) or edits a draft or a scheduled one.
struct CampaignEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    @Environment(ReferenceStore.self) private var reference

    let campaign: Campaign?
    let onSave: (Campaign) -> Void

    private let initial: CampaignDraft
    @State private var draft: CampaignDraft
    @State private var audience: CampaignAudience?
    @State private var mastersFailure: String?
    @State private var isUploading = false
    @State private var isSaving = false
    @State private var confirmsDiscard = false
    @State private var errorMessage: String?

    init(campaign: Campaign?, onSave: @escaping (Campaign) -> Void) {
        self.campaign = campaign
        self.onSave = onSave
        let draft = campaign.map(CampaignDraft.init(campaign:)) ?? CampaignDraft()
        initial = draft
        _draft = State(initialValue: draft)
    }

    private var hasChanges: Bool { draft != initial }
    private var canSave: Bool { draft.issue == nil && !isUploading && !isSaving && (campaign == nil || hasChanges) }

    /// Masters for the segment: active ones, plus former ones the segment already names.
    private var masters: [Employee] {
        reference.employees.filter { $0.isMaster && ($0.active || draft.segment.masterIds.contains($0.id)) }
    }

    var body: some View {
        NavigationStack {
            Form {
                CampaignMessageSections(draft: $draft)
                CampaignImageSection(imageUrl: $draft.imageUrl, isUploading: $isUploading, errorMessage: $errorMessage)
                CampaignButtonSection(draft: $draft)
                CampaignPreviewSection(draft: draft, audience: audience)
                CampaignSegmentSections(segment: $draft.segment, masters: masters, mastersFailure: mastersFailure)
                CampaignAudienceSection(segment: draft.segment.segment, audience: $audience)
            }
            .navigationTitle(campaign == nil ? "Новая рассылка" : "Рассылка")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .task { await loadMasters() }
            .interactiveDismissDisabled(hasChanges || isSaving || isUploading)
            .confirmationDialog("Закрыть без сохранения?", isPresented: $confirmsDiscard, titleVisibility: .visible) {
                Button("Не сохранять", role: .destructive) { dismiss() }
                Button("Продолжить", role: .cancel) {}
            }
            .errorAlert($errorMessage)
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Отмена", role: .cancel) {
                if hasChanges { confirmsDiscard = true } else { dismiss() }
            }
            .disabled(isSaving || isUploading)
        }
        ToolbarItem(placement: .confirmationAction) {
            if isSaving {
                ProgressView()
            } else {
                Button(campaign == nil ? "Создать" : "Сохранить", action: save).disabled(!canSave)
            }
        }
    }

    private func loadMasters() async {
        do {
            try await reference.ensureEmployees()
            mastersFailure = nil
        } catch is CancellationError {
            return
        } catch {
            mastersFailure = "Не удалось загрузить мастеров: \(error.userMessage)"
        }
    }

    private func save() {
        let body = draft.body
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let saved = if let campaign {
                    try await api.updateCampaign(id: campaign.id, body)
                } else {
                    try await api.createCampaign(body)
                }
                onSave(saved)
                dismiss()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    CampaignEditorView(campaign: PreviewData.campaign) { _ in }
        .previewEnvironment()
}
#endif
