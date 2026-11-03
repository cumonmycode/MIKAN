import SwiftUI

/// A gift certificate: its card to share, print or send, balance and validity, who bought it, the sale and every
/// operation. Staff fix the recipient and the note; the owner also changes the expiry and can cancel an active one
/// (its balance burns).
struct CertificateDetailView: View {
    @Environment(APIClient.self) private var api
    @Environment(\.permissions) private var permissions

    @State private var certificate: GiftCertificate
    @State private var showsCancel = false
    @State private var showsEdit = false
    @State private var errorMessage: String?
    var onChange: ((GiftCertificate) -> Void)?

    init(certificate: GiftCertificate, onChange: ((GiftCertificate) -> Void)? = nil) {
        _certificate = State(initialValue: certificate)
        self.onChange = onChange
    }

    var body: some View {
        List {
            Section {
                CertificateCardActions(certificate: certificate)
            }
            infoSection
            operationsSection
            AuditHistorySection(scope: .certificate(id: certificate.id))
        }
        .auraBackground()
        .navigationTitle(certificate.code)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .errorAlert($errorMessage)
        .toolbar {
            if permissions.editsCertificateDetails {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Изменить") { showsEdit = true }
                }
            }
            if permissions.cancelsCertificates, certificate.status == .active {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Отменить сертификат", systemImage: "xmark.circle", role: .destructive) { showsCancel = true }
                    } label: {
                        Label("Действия", systemImage: "ellipsis")
                    }
                }
            }
        }
        .sheet(isPresented: $showsCancel) {
            CertificateCancelSheet(certificate: certificate) { cancelled in apply(cancelled) }
        }
        .sheet(isPresented: $showsEdit) {
            CertificateEditSheet(certificate: certificate) { edited in apply(edited) }
        }
    }

    private var infoSection: some View {
        Section("Сертификат") {
            LabeledContent("Статус") { CertificateStatusBadge(status: certificate.status) }
            LabeledContent("Остаток") { MoneyText(certificate.balance).fontWeight(.semibold) }
            LabeledContent("Номинал") { MoneyText(certificate.amount) }
            LabeledContent("Действует", value: CertificateText.validity(certificate.expiresAt))
            if let recipient = certificate.recipientName.nonEmpty {
                LabeledContent("Кому", value: recipient)
            }
            if let buyer = certificate.buyer {
                NavigationLink {
                    ClientDetailView(clientId: buyer.id)
                } label: {
                    LabeledContent("Покупатель", value: buyer.fullName)
                }
            }
            if let saleId = certificate.saleId {
                NavigationLink {
                    SaleLoaderView(saleId: saleId)
                } label: {
                    LabeledContent("Продан", value: certificate.saleNumber.map { "чек №\($0)" } ?? "чек")
                }
            }
            LabeledContent("Дата продажи", value: DateText.dateTime(certificate.createdAt))
            if let note = certificate.note.nonEmpty {
                Text(note).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var operationsSection: some View {
        if !certificate.operations.isEmpty {
            Section("Операции") {
                ForEach(Array(certificate.operations.enumerated().reversed()), id: \.offset) { _, operation in
                    CertificateOperationRow(operation: operation)
                }
            }
        }
    }

    private func reload() async {
        do {
            apply(try await api.certificate(id: certificate.id))
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.userMessage
        }
    }

    private func apply(_ updated: GiftCertificate) {
        certificate = updated
        onChange?(updated)
    }
}

private struct CertificateOperationRow: View {
    let operation: GiftCertificateOperation

    private var signed: Int { CertificateText.signedAmount(type: operation.type, amount: operation.amount) }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(CertificateText.operationTitle(operation.type))
                Text(subtitle).font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            Spacer(minLength: 8)
            Text(Money.formatSigned(signed))
                .monospacedDigit()
                .foregroundStyle(signed < 0 ? Color.primary : Color.green)
        }
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String {
        let date = DateText.dateTime(operation.createdAt)
        guard let number = operation.saleNumber else { return date }
        return "\(date) · чек №\(number)"
    }
}

/// «Отменить сертификат»: owner only, with a reason; what is left on it burns.
private struct CertificateCancelSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    let certificate: GiftCertificate
    let onCancelled: (GiftCertificate) -> Void

    @State private var reason = ""
    @State private var confirms = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Сгорит остаток") { MoneyText(certificate.balance).fontWeight(.semibold) }
                } footer: {
                    Text("Сертификатом больше нельзя будет оплатить. Деньги покупателю приложение не возвращает.")
                }
                Section {
                    TextField("Например, клиент вернул сертификат", text: $reason, axis: .vertical)
                        .lineLimit(2...5)
                } header: {
                    Text("Причина")
                } footer: {
                    Text("Обязательно укажите причину.")
                }
            }
            .navigationTitle("Отмена сертификата")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Закрыть", role: .close) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Отменить") { confirms = true }.disabled(reason.trimmed.isEmpty)
                    }
                }
            }
            .confirmationDialog("Отменить сертификат \(certificate.code)?", isPresented: $confirms, titleVisibility: .visible) {
                Button("Отменить сертификат", role: .destructive, action: cancel)
                Button("Не отменять", role: .cancel) {}
            } message: {
                Text("Остаток \(Money.format(certificate.balance)) сгорит. Это действие нельзя отменить.")
            }
            .errorAlert($errorMessage, title: "Сертификат не отменён")
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(isSaving)
    }

    private func cancel() {
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                onCancelled(try await api.cancelCertificate(id: certificate.id, reason: reason.trimmed))
                dismiss()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        CertificateDetailView(certificate: PreviewData.certificate)
    }
    .previewEnvironment()
}
#endif
