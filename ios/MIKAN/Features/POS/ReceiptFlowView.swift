import SwiftUI

/// The cart's receipt as one full-screen task: lines, totals and payment on one screen, the QR code over it, then the
/// success screen. Presented right where it was asked for (the POS hub, an appointment, a client card) with
/// `receiptFlow(isPresented:)`; being full-screen, only one can be open, so the single shared cart is never shown twice.
/// Leaving it saves the receipt at once (a «Новый чек» left empty is deleted); it stays open for every device.
struct ReceiptFlowView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppState.self) private var appState
    @Environment(CartStore.self) private var cart
    @Environment(OpenReceiptsStore.self) private var receipts

    @State private var checkout: ReceiptCheckout
    /// Jewelry and goods, loaded with the screen so the catalog opens ready.
    @State private var catalog = Remote<[Product]>()

    /// While the receipt is on screen it is re-read this often, so one paid or edited on another phone shows up.
    private static let syncInterval: Duration = .seconds(15)

    init(state: AppState) {
        _checkout = State(initialValue: ReceiptCheckout(state: state))
    }

    var body: some View {
        NavigationStack {
            switch checkout.phase {
            case .editing:
                ReceiptView(checkout: checkout, catalog: catalog, onClose: close)
            case .sold(let outcome):
                SaleSuccessView(outcome: outcome, onNewSale: startNewSale, onDone: finish)
            }
        }
        .offlineBanner()
        .background { ReceiptAutosave() }
        .sheet(item: qrPayment) { payment in
            QRPaymentSheet(payment: payment, checkout: checkout)
        }
        .errorAlert(goneNotice, title: "Чек закрыт")
        .sensoryFeedback(.success, trigger: checkout.isSold) { _, isSold in isSold }
        .task(id: checkout.isSold) {
            guard !checkout.isSold else { return }
            await syncWhileEditing()
        }
        .onChange(of: cart.receiptId) { _, id in
            // Deleted here, or let go because its appointment was cancelled: nothing is left to show.
            if id == nil, !checkout.isSold, receipts.goneNotice == nil { close() }
        }
        .onAppear {
            appState.isReceiptOpen = true
            // A notice about an earlier receipt that could not be shown is out of date now.
            if cart.receiptId != nil { receipts.goneNotice = nil }
        }
        .onDisappear {
            appState.isReceiptOpen = false
            if checkout.isSold { cart.clear() }
        }
    }

    private var qrPayment: Binding<QrPayment?> {
        Binding(get: { checkout.qrPayment }, set: { checkout.qrPayment = $0 })
    }

    /// Paid or deleted on another device: the notice, then back to where the receipt was opened.
    private var goneNotice: Binding<String?> {
        Binding(
            get: { receipts.goneNotice },
            set: { notice in
                receipts.goneNotice = notice
                if notice == nil { close() }
            }
        )
    }

    private func syncWhileEditing() async {
        while !Task.isCancelled {
            // Not while it is being paid: a QR code paid or a sale that went through deletes the receipt on the server,
            // and the cart must stay as it is until the outcome is known.
            if !checkout.isPaying { await receipts.syncCart() }
            try? await Task.sleep(for: Self.syncInterval)
        }
    }

    private func startNewSale() async throws {
        try await checkout.startNewSale()
    }

    private func finish() {
        cart.clear()
        close()
    }

    /// Back to where the receipt was opened. Its last save (or deleting a «Новый чек» left empty) starts right away,
    /// and the screen below reloads only after it.
    private func close() {
        receipts.leaveInBackground()
        dismiss()
    }
}

/// Saves the cart's receipt shortly after each change (see `OpenReceiptsStore`). It sits behind the receipt flow, so
/// edits on the receipt, in its sheets and in the client picker are all caught.
private struct ReceiptAutosave: View {
    @Environment(CartStore.self) private var cart
    @Environment(OpenReceiptsStore.self) private var receipts

    var body: some View {
        Color.clear
            .accessibilityHidden(true)
            .onChange(of: cart.makeReceiptBody()) {
                receipts.cartDidChange()
            }
    }
}

/// The SBP QR step over the receipt; it cannot be swiped away while the code waits for the payment.
private struct QRPaymentSheet: View {
    let payment: QrPayment
    let checkout: ReceiptCheckout

    var body: some View {
        @Bindable var checkout = checkout
        NavigationStack {
            QRPaymentView(
                payment: payment,
                isRenewing: checkout.isSubmitting,
                onPaid: checkout.qrPaid,
                onPaidWithoutSale: checkout.qrPaidWithoutSale,
                onBack: checkout.leaveQr,
                onRenew: checkout.renewQrPayment
            )
            .id(payment.id)
            .navigationTitle("Оплата по QR")
            .navigationBarTitleDisplayMode(.inline)
            // A new code that could not be created is reported here, over the receipt.
            .errorAlert($checkout.errorMessage, title: checkout.errorTitle)
        }
        .interactiveDismissDisabled()
    }
}

extension View {
    /// Presents the cart's receipt over the screen (open it into the cart first, e.g. `AppState.startCheckout`).
    func receiptFlow(isPresented: Binding<Bool>, onDismiss: (() -> Void)? = nil) -> some View {
        modifier(ReceiptFlowPresenter(isPresented: isPresented, onDismiss: onDismiss))
    }
}

private struct ReceiptFlowPresenter: ViewModifier {
    @Environment(AppState.self) private var appState
    @Binding var isPresented: Bool
    let onDismiss: (() -> Void)?

    func body(content: Content) -> some View {
        content.fullScreenCover(isPresented: $isPresented, onDismiss: onDismiss) {
            ReceiptFlowView(state: appState)
        }
    }
}
