import SwiftUI

/// «Возврат»: the lines and units to return, the reason and the stock. The server's preview shows what goes back and
/// how before anything is written; the refund itself carries one `Idempotency-Key` per confirmation.
struct RefundSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    @Environment(ShiftStore.self) private var shift
    let sale: Sale
    let onRefunded: (Sale) -> Void

    @State private var selection: RefundSelection
    @State private var reason = ""
    @State private var restock = true
    @State private var preview: RefundPreview?
    /// The choice `preview` belongs to.
    @State private var previewItems: [RefundItemBody]?
    @State private var previewError: String?
    /// Bumped to ask for the preview again (a shift was opened, a refund failed).
    @State private var previewGeneration = 0
    @State private var confirms = false
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var retryMessage: String?
    @State private var refundKey = IdempotencyKey()
    /// Cash refunds need an open shift; the server answers 409 otherwise.
    @State private var shiftRequiredMessage: String?
    @State private var showsOpenShift = false

    private static let previewDebounce: Duration = .milliseconds(300)

    init(sale: Sale, onRefunded: @escaping (Sale) -> Void) {
        self.sale = sale
        self.onRefunded = onRefunded
        _selection = State(initialValue: RefundSelection(sale: sale))
    }

    private struct PreviewRequest: Equatable {
        let items: [RefundItemBody]
        let generation: Int
    }

    /// The preview of what is chosen now; `nil` while it loads.
    private var currentPreview: RefundPreview? {
        previewItems == selection.items ? preview : nil
    }

    private var refundBody: RefundBody? { selection.body(reason: reason, restock: restock) }

    private var canRefund: Bool {
        guard let currentPreview, refundBody != nil else { return false }
        return !currentPreview.needsShift && !isSaving
    }

    private var confirmTitle: String {
        currentPreview.map { SaleRefundText.confirmButton($0.payments) } ?? "Вернуть"
    }

    var body: some View {
        NavigationStack {
            Form {
                RefundLinesSection(selection: $selection)
                RefundReasonSection(reason: $reason)
                if selection.hasProducts {
                    Section {
                        Toggle("Вернуть на склад", isOn: $restock)
                    } footer: {
                        Text(SaleRefundText.restockNote(selection.selectedLines.map { line in
                            (item: line.item, quantity: selection.quantity(of: line.id) ?? 0)
                        }))
                    }
                }
                if !selection.isEmpty {
                    if currentPreview?.needsShift == true {
                        RefundNeedsShiftSection { showsOpenShift = true }
                    }
                    RefundPreviewSection(
                        preview: preview,
                        isCurrent: currentPreview != nil,
                        error: previewError,
                        showsItems: sale.discount > 0 || selection.items.count > 1,
                        hasCertificates: selection.hasCertificates,
                        retry: reloadPreview
                    )
                }
            }
            .navigationTitle("Возврат №\(sale.number)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
            }
            .safeAreaBar(edge: .bottom) { confirmBar }
            .sensoryFeedback(.selection, trigger: selection)
            .interactiveDismissDisabled(isSaving)
            .confirmationDialog(
                SaleRefundText.confirmationTitle(isWhole: selection.isWhole),
                isPresented: $confirms,
                titleVisibility: .visible
            ) {
                Button(confirmTitle, role: .destructive, action: refund)
                Button("Отмена", role: .cancel) {}
            } message: {
                if let currentPreview {
                    Text(SaleRefundText.confirmationMessage(currentPreview.payments, isWhole: selection.isWhole))
                }
            }
            .errorAlert($errorMessage)
            .retryAlert($retryMessage, title: "Возврат мог пройти", retry: refund)
            .alert("Смена закрыта", isPresented: Binding(
                get: { shiftRequiredMessage != nil },
                set: { if !$0 { shiftRequiredMessage = nil } }
            )) {
                Button("Открыть смену") { showsOpenShift = true }
                Button("Отмена", role: .cancel) {}
            } message: {
                Text(shiftRequiredMessage ?? "")
            }
            .sheet(isPresented: $showsOpenShift, onDismiss: reloadPreview) {
                OpenShiftSheet()
            }
            .task(id: PreviewRequest(items: selection.items, generation: previewGeneration)) { await loadPreview() }
            .task { if !shift.hasLoaded { await shift.refresh() } }
        }
    }

    private var confirmBar: some View {
        Button { confirms = true } label: {
            Group {
                if isSaving {
                    ProgressView()
                } else {
                    Text(confirmTitle).font(.headline).monospacedDigit()
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
        }
        .buttonStyle(.glassProminent)
        .tint(.red)
        .controlSize(.large)
        .disabled(!canRefund)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    // MARK: - Preview

    private func reloadPreview() {
        previewItems = nil
        previewGeneration += 1
    }

    /// After a short pause (the stepper may still be moving): what the chosen units would return.
    private func loadPreview() async {
        let items = selection.items
        previewError = nil
        guard !items.isEmpty else { return }
        try? await Task.sleep(for: Self.previewDebounce)
        guard !Task.isCancelled else { return }
        do {
            let result = try await api.refundPreview(saleId: sale.id, items: items)
            guard !Task.isCancelled else { return }
            preview = result
            previewItems = items
        } catch {
            guard !Task.isCancelled, !(error is CancellationError) else { return }
            previewError = error.userMessage
        }
    }

    // MARK: - Refund

    private func refund() {
        guard let body = refundBody else { return }
        let key = refundKey.key(for: body)
        let returnsCash = (currentPreview?.payments.cash ?? 0) > 0
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let refunded = try await api.refundSale(id: sale.id, body, idempotencyKey: key)
                onRefunded(refunded)
                await shift.refresh()
                dismiss()
            } catch let error as APIError where error.isOutcomeUnknown {
                retryMessage = "Связь прервалась до ответа сервера. Нажмите «Повторить» — если возврат уже прошёл, второй раз он не проведётся."
            } catch let error as APIError where error.status == 409 {
                // The shift may have been closed on another device since the preview.
                await shift.refresh()
                if returnsCash, shift.current == nil {
                    shiftRequiredMessage = error.message
                } else {
                    errorMessage = error.message
                }
                reloadPreview()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    RefundSheet(sale: PreviewData.sale) { _ in }
        .previewEnvironment()
}
#endif
