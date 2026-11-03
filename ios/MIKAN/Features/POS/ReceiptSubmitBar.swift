import SwiftUI

/// The big button under the receipt: «Провести · 3 500 ₽», «Показать QR-код · 3 500 ₽», or «Открыть смену» while no
/// cash shift is open (selling needs one; after opening it the cashier taps «Провести»).
struct ReceiptSubmitBar: View {
    @Environment(CartStore.self) private var cart
    @Environment(ShiftStore.self) private var shift
    let checkout: ReceiptCheckout
    let onOpenShift: () -> Void

    private var action: ReceiptSubmitAction {
        ReceiptSubmitAction.of(
            shiftIsOpen: shift.hasLoaded ? shift.current != nil : nil,
            qrShare: cart.split.qr,
            amountDue: cart.amountDue
        )
    }

    var body: some View {
        VStack(spacing: 8) {
            // Offline the receipt stays as it is; only paying waits for the network.
            OfflinePaymentNote()
            if action == .openShift {
                Text("Продажи проводятся в открытой кассовой смене")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            button
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .animation(.snappy, value: action)
    }

    private var button: some View {
        Button(action: tap) {
            ZStack {
                Group {
                    if let symbol = action.systemImage {
                        Label(action.title, systemImage: symbol)
                    } else {
                        Text(action.title)
                    }
                }
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .contentTransition(.numericText())
                .opacity(checkout.isSubmitting ? 0 : 1)
                if checkout.isSubmitting { ProgressView().tint(.white) }
            }
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 32)
            .padding(.vertical, 6)
        }
        .buttonStyle(.glassProminent)
        .controlSize(.large)
        .disabled(isDisabled)
        .needsConnection()
        .accessibilityHint(hint)
    }

    private var isDisabled: Bool {
        if checkout.isSubmitting { return true }
        return action != .openShift && !cart.canSubmit
    }

    private var hint: String {
        if action == .openShift { return "Откроется смена; затем проведите продажу" }
        if cart.isEmpty { return "Добавьте позиции в чек" }
        if !cart.isDiscountValid { return "Скидка больше суммы чека" }
        if !cart.isCashReceivedEnough { return "Получено меньше суммы к оплате" }
        if cart.remaining != 0 { return "Распределите сумму к оплате между способами оплаты" }
        return ""
    }

    private func tap() {
        if action == .openShift {
            onOpenShift()
        } else {
            checkout.submit()
        }
    }
}
