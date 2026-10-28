import SwiftUI

/// What the hub is opening right now (its row shows a spinner; other taps wait).
enum POSOpening: Hashable {
    case receipt(Int)
    case visit(appointmentId: Int)
    case newReceipt
}

extension View {
    /// A card row of the POS hub list: no row background, separators or side insets.
    func hubRow(top: CGFloat = 5, bottom: CGFloat = 5) -> some View {
        listRowInsets(EdgeInsets(top: top, leading: 0, bottom: bottom, trailing: 0))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
    }

    /// «Удалить чек?» with what deleting changes; `onDelete` runs on «Удалить чек».
    func receiptDeletionDialog(_ deletion: Binding<ReceiptDeletion?>, onDelete: @escaping (ReceiptDeletion) -> Void) -> some View {
        confirmationDialog(
            OpenReceiptText.deleteTitle,
            isPresented: Binding(
                get: { deletion.wrappedValue != nil },
                set: { if !$0 { deletion.wrappedValue = nil } }
            ),
            titleVisibility: .visible,
            presenting: deletion.wrappedValue
        ) { receipt in
            Button("Удалить чек", role: .destructive) { onDelete(receipt) }
            Button("Отмена", role: .cancel) {}
        } message: { receipt in
            Text(receipt.message)
        }
    }
}

/// «Предоплата N ₽» (held, applied at checkout) or «Ждём предоплату N ₽» (required, not received yet).
struct QueueDepositBadgeView: View {
    let badge: QueueDepositBadge

    var body: some View {
        switch badge {
        case .held:
            StatusBadge(text: badge.text, color: .green, systemImage: PaymentLine.depositSymbol)
        case .waiting:
            StatusBadge(text: badge.text, color: .orange, systemImage: "hourglass")
        }
    }
}

/// Chevron of a hub row, or a spinner while it is being opened.
struct RowAccessory: View {
    let isWorking: Bool

    var body: some View {
        Group {
            if isWorking {
                ProgressView()
            } else {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(width: 20)
        .accessibilityHidden(true)
    }
}
