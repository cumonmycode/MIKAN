import SwiftUI

/// «Изменить сертификат»: who it is for and a note for colleagues; the owner also sets until when it is valid.
struct CertificateEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    @Environment(\.permissions) private var permissions
    let certificate: GiftCertificate
    let onSaved: (GiftCertificate) -> Void

    @State private var draft: CertificateEditDraft
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(certificate: GiftCertificate, onSaved: @escaping (GiftCertificate) -> Void) {
        self.certificate = certificate
        self.onSaved = onSaved
        _draft = State(initialValue: CertificateEditDraft(certificate))
    }

    private var editsExpiry: Bool {
        permissions.changesCertificateExpiry && CertificateEditDraft.allowsExpiryChange(certificate.status)
    }

    private var issue: String? { draft.issue() }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Например, Маше", text: $draft.recipientName)
                        .textInputAutocapitalization(.words)
                } header: {
                    Text("Кому")
                } footer: {
                    Text("Имя появится на карточке сертификата и в сообщении бота.")
                }
                Section {
                    TextField("Например, подарок на день рождения", text: $draft.note, axis: .vertical)
                        .lineLimit(2...6)
                } header: {
                    Text("Заметка")
                } footer: {
                    Text("Видят только сотрудники.")
                }
                expirySection
                if let issue {
                    Section {
                        Label(issue, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Сертификат")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Сохранить", action: save).disabled(!draft.canSave())
                    }
                }
            }
            .errorAlert($errorMessage, title: "Сертификат не сохранён")
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(isSaving || draft.hasChanges)
    }

    @ViewBuilder
    private var expirySection: some View {
        if editsExpiry {
            Section {
                Toggle("Ограничен по сроку", isOn: $draft.expires.animation())
                if draft.expires {
                    DatePicker(
                        "Последний день",
                        selection: $draft.lastDay,
                        in: Calendar.app.startOfDay(for: .now)...,
                        displayedComponents: .date
                    )
                }
            } header: {
                Text("Срок действия")
            } footer: {
                Text(draft.expires ? "Сертификатом можно оплатить до конца этого дня." : "Без срока — сертификат не сгорит.")
            }
        } else {
            Section {
                LabeledContent("Действует", value: CertificateText.validity(certificate.expiresAt))
            } footer: {
                Text(permissions.changesCertificateExpiry
                    ? "Сертификат уже не действует — срок изменить нельзя."
                    : "Срок действия меняет владелец студии.")
            }
        }
    }

    private func save() {
        let body = draft.body
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                onSaved(try await api.updateCertificate(id: certificate.id, body))
                dismiss()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    CertificateEditSheet(certificate: PreviewData.certificate) { _ in }
        .previewEnvironment()
}
#endif
