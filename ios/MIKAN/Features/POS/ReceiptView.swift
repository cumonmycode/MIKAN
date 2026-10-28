import SwiftUI

/// «Чек» — the receipt and its checkout on one screen: who it is for, the lines with the add buttons, the totals, the
/// payment method, the visit's completion, and «Провести · N ₽» at the bottom. Every change is saved to the open
/// receipt on the server. Lives in `ReceiptFlowView`.
struct ReceiptView: View {
    @Environment(AppState.self) private var appState
    @Environment(APIClient.self) private var api
    @Environment(CartStore.self) private var cart
    @Environment(ReferenceStore.self) private var reference
    @Environment(ShiftStore.self) private var shift

    let checkout: ReceiptCheckout
    /// Jewelry and goods for the catalog; owned by the flow, so it stays loaded between receipts.
    let catalog: Remote<[Product]>
    let onClose: () -> Void

    /// The catalog segment last used, kept across receipts and launches.
    @AppStorage(POSCatalog.storageKey) private var segment = POSCatalog.jewelry
    @State private var sheet: ReceiptSheet?
    @State private var picksClient = false
    @State private var deletion: ReceiptDeletion?
    @State private var isDeleting = false
    @State private var deleteError: String?

    /// Whose prices catalog services take: the visit's master, else whoever opened the receipt when a master.
    private var masterId: Int? {
        ReceiptPricing.masterId(
            appointmentMasterId: cart.appointment?.master.id,
            openedBy: cart.openedBy?.id,
            masterIds: ReceiptPricing.masterIds(employees: reference.employees, signedIn: appState.employee)
        )
    }

    var body: some View {
        List {
            ReceiptHeaderSection { picksClient = true }
            ReceiptLinesSection(onEdit: edit, onAdd: add)
            if !cart.isEmpty {
                ReceiptTotalsSection(onDiscount: { sheet = .discount }, onCertificate: { sheet = .certificateLookup(code: $0) })
                ReceiptPaymentSection()
                ReceiptVisitSection()
            }
        }
        // Nothing changes while the sale is on its way: it was built from the cart as it was.
        .disabled(checkout.isSubmitting)
        .listSectionSpacing(.compact)
        .auraBackground()
        .scrollDismissesKeyboard(.interactively)
        .safeAreaBar(edge: .bottom) {
            ReceiptSubmitBar(checkout: checkout) { sheet = .openShift }
        }
        .loadsCheckoutLoyalty()
        .navigationTitle("Чек")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .navigationDestination(isPresented: $picksClient) {
            ClientPickerView(selection: Binding(get: { cart.client }, set: { cart.client = $0 }))
        }
        .sheet(item: $sheet) { sheet in
            content(for: sheet)
        }
        .receiptDeletionDialog($deletion, onDelete: delete)
        .errorAlert($deleteError, title: "Чек не удалён")
        // While the QR code is up its sheet shows the errors.
        .errorAlert(
            Binding(get: { checkout.qrPayment == nil ? checkout.errorMessage : nil }, set: { checkout.errorMessage = $0 }),
            title: checkout.errorTitle
        )
        .retryAlert(
            Binding(get: { checkout.retryMessage }, set: { checkout.retryMessage = $0 }),
            title: "Продажа могла пройти",
            retry: checkout.submit
        )
        // The catalog sheet refreshes it each time it opens; here it only gets ready.
        .task { if catalog.value == nil { await loadCatalog() } }
        .task { await loadReference() }
        .onChange(of: cart.receiptId) { _, id in
            // Paid or deleted elsewhere: the sheets go, so the notice can show.
            if id == nil { sheet = nil }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Закрыть", systemImage: "xmark", role: .close, action: onClose)
                .disabled(checkout.isSubmitting)
                .accessibilityHint("Чек сохранится и останется в «К оплате»")
        }
        if let receiptId = cart.receiptId {
            ToolbarItem(placement: .topBarTrailing) {
                if isDeleting {
                    ProgressView()
                } else {
                    Menu {
                        Button("Удалить чек", systemImage: "trash", role: .destructive) {
                            deletion = ReceiptDeletion(
                                id: receiptId, subtotal: cart.subtotal, itemCount: cart.itemCount,
                                hasAppointment: cart.appointment != nil
                            )
                        }
                    } label: {
                        Label("Действия с чеком", systemImage: "ellipsis")
                    }
                    .disabled(checkout.isSubmitting)
                }
            }
        }
    }

    @ViewBuilder
    private func content(for sheet: ReceiptSheet) -> some View {
        switch sheet {
        case .catalog:
            CatalogSheet(segment: $segment, catalog: catalog, masterId: masterId, reload: loadCatalog)
        case .line(let line):
            ReceiptLineSheet(initial: line)
        case .discount:
            ReceiptDiscountSheet()
        case .certificateSale:
            CertificateSaleSheet()
        case .certificateLookup(let code):
            CertificateLookupSheet(initialCode: code ?? "")
        case .openShift:
            OpenShiftSheet()
        }
    }

    // MARK: Actions

    private func edit(_ id: CartLine.ID) {
        guard let line = cart.lines.first(where: { $0.id == id }) else { return }
        sheet = .line(line)
    }

    private func add(_ addition: ReceiptAddition) {
        guard let catalog = addition.catalog else {
            sheet = .certificateSale
            return
        }
        segment = catalog
        sheet = .catalog
    }

    /// Nothing is sold or returned; the flow closes once the cart lets the receipt go.
    private func delete(_ deletion: ReceiptDeletion) {
        isDeleting = true
        Task {
            defer { isDeleting = false }
            do {
                try await appState.deleteReceipt(id: deletion.id, hasAppointment: deletion.hasAppointment)
            } catch {
                deleteError = error.userMessage
            }
        }
    }

    // MARK: Loading

    /// Jewelry and goods in one go: both segments come from the same catalog.
    private func loadCatalog() async {
        await catalog.load {
            async let jewelry = api.products(kind: .jewelry)
            async let goods = api.products(kind: .goods)
            return try await jewelry + goods
        }
    }

    /// Whether QR payments are on, the services (aftercare memo, catalog), who is a master (prices), category order
    /// and the shift. Each one failing only hides what it adds; the server checks everything again.
    private func loadReference() async {
        async let qr: Void = loadQrConfig()
        async let services: Void? = try? reference.ensureServices()
        async let employees: Void? = try? reference.ensureEmployees()
        async let categories: Void? = try? reference.ensureCategories()
        if !shift.hasLoaded { await shift.refresh() }
        _ = await (qr, services, employees, categories)
    }

    private func loadQrConfig() async {
        try? await reference.ensureQrPaymentsConfig()
        cart.dropQrIfUnavailable(qrEnabled: reference.qrPaymentsEnabled)
    }
}

/// The sheets over the receipt, one at a time.
enum ReceiptSheet: Identifiable {
    case catalog
    case line(CartLine)
    case discount
    case certificateSale
    /// `code` — a certificate already paying the receipt, to change its amount.
    case certificateLookup(code: String?)
    case openShift

    var id: String {
        switch self {
        case .catalog: "catalog"
        case .line(let line): "line-\(line.id)"
        case .discount: "discount"
        case .certificateSale: "certificate-sale"
        case .certificateLookup(let code): "certificate-lookup-\(code ?? "")"
        case .openShift: "open-shift"
        }
    }
}

#if DEBUG
#Preview("По записи") {
    let state = PreviewData.appState()
    state.cart.prefill(from: PreviewData.appointments[0])
    state.cart.add(product: PreviewData.labret, variant: PreviewData.labret.variants[1])
    state.cart.add(product: PreviewData.ring)
    return NavigationStack {
        ReceiptView(
            checkout: ReceiptCheckout(state: state),
            catalog: Remote(PreviewData.products.filter(\.kind.isSold) + [PreviewData.aftercareSpray]),
            onClose: {}
        )
    }
    .appEnvironment(state)
}

#Preview("Без записи") {
    let state = PreviewData.appState()
    return NavigationStack {
        ReceiptView(checkout: ReceiptCheckout(state: state), catalog: Remote(PreviewData.products), onClose: {})
    }
    .appEnvironment(state)
}
#endif
