import SwiftUI

/// «Позиции» of a sale: each line with the units returned so far, the totals and what refunds gave back.
struct SaleLinesSection: View {
    let sale: Sale

    var body: some View {
        Section("Позиции") {
            ForEach(sale.items) { item in
                line(item)
            }
            if sale.discount > 0 {
                LabeledContent("Подытог") { MoneyText(sale.subtotal) }
                LabeledContent("Скидка") { Text("−" + Money.format(sale.discount)).monospacedDigit() }
            }
            LabeledContent("Итого") { MoneyText(sale.total).fontWeight(.bold) }
            if sale.returnedAmount > 0, !sale.isRefunded {
                LabeledContent("Возвращено") {
                    Text(Money.minus + Money.format(sale.returnedAmount)).monospacedDigit()
                }
                .foregroundStyle(.orange)
                LabeledContent("Осталось") { MoneyText(sale.total - sale.returnedAmount).fontWeight(.semibold) }
            }
        }
    }

    private func line(_ item: SaleItem) -> some View {
        let returned = sale.returnedQuantity(of: item)
        let isFullyReturned = returned >= item.quantity
        return HStack(alignment: .firstTextBaseline) {
            if item.isCertificate {
                Image(systemName: PaymentLine.certificateSymbol)
                    .foregroundStyle(Color.accentColor)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name)
                    .foregroundStyle(isFullyReturned ? .secondary : .primary)
                Text("\(item.quantity) × \(Money.format(item.price))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                if let text = SaleRefundText.returnedUnits(returned, of: item.quantity) {
                    Label(text, systemImage: "arrow.uturn.backward")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.orange)
                }
            }
            Spacer()
            MoneyText(item.total)
                .strikethrough(isFullyReturned)
                .foregroundStyle(isFullyReturned ? .secondary : .primary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// «Возвраты»: every refund of the sale — when, who, what, how much and how it went back, why.
struct SaleRefundsSection: View {
    let sale: Sale

    var body: some View {
        if let refunds = sale.refunds, !refunds.isEmpty {
            Section("Возвраты") {
                ForEach(refunds) { refund in
                    SaleRefundRow(refund: refund, restockedProducts: restockedProducts(refund))
                }
            }
        } else if sale.isRefunded {
            // A server without partial refunds: the sale's own refund fields.
            Section("Возврат") {
                if let refundedAt = sale.refundedAt {
                    LabeledContent("Дата", value: DateText.dateTime(refundedAt))
                }
                if let reason = sale.refundReason.nonEmpty {
                    LabeledContent("Причина", value: reason)
                }
            }
        }
    }

    /// The refund put product units back to the stock.
    private func restockedProducts(_ refund: SaleRefund) -> Bool {
        guard refund.restock else { return false }
        let productLines = Set(sale.items.filter { $0.type == .product && !$0.isCertificate }.map(\.id))
        return refund.items.contains { productLines.contains($0.saleItemId) }
    }
}

private struct SaleRefundRow: View {
    let refund: SaleRefund
    let restockedProducts: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(SaleRefundText.refundSubtitle(refund))
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                Spacer(minLength: 8)
                Text(Money.minus + Money.format(refund.amount))
                    .font(.headline)
                    .monospacedDigit()
            }
            ForEach(refund.items, id: \.saleItemId) { item in
                HStack(alignment: .firstTextBaseline) {
                    Text(SaleRefundText.itemLine(item))
                    Spacer(minLength: 8)
                    MoneyText(item.amount).foregroundStyle(.secondary)
                }
                .font(.subheadline)
            }
            ForEach(RefundOutcome.lines(refund)) { line in
                HStack(alignment: .firstTextBaseline) {
                    Label(line.recordedTitle, systemImage: line.symbol)
                    Spacer(minLength: 8)
                    Text(line.value).monospacedDigit()
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            if restockedProducts {
                Label("Вернули на склад", systemImage: "shippingbox")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let reason = refund.reason.nonEmpty {
                Text("Причина: \(reason)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// The receipt in the client's Telegram: when the bot sent it, and sending it (again). Only for a sale with a client,
/// or one whose receipt already went out.
struct SaleReceiptSection: View {
    @Environment(APIClient.self) private var api
    let sale: Sale
    let onSent: (Sale) -> Void

    @State private var isSending = false
    @State private var sentCount = 0
    @State private var errorMessage: String?

    var body: some View {
        if sale.client != nil || sale.receiptSentAt != nil {
            Section {
                if let sentAt = sale.receiptSentAt {
                    Label(SaleReceiptText.sent(at: sentAt), systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .monospacedDigit()
                }
                Button(action: send) {
                    HStack {
                        Label(sale.receiptSentAt == nil ? "Отправить чек в Telegram" : "Отправить ещё раз", systemImage: "paperplane")
                        if isSending {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(isSending)
                // On the row, not the section: section modifiers repeat on every row.
                .errorAlert($errorMessage, title: "Чек не отправлен")
                .sensoryFeedback(.success, trigger: sentCount)
            } header: {
                Text("Чек клиенту")
            }
        }
    }

    /// The server's own message on a 409 («У клиента нет Telegram — отправить чек некуда», «Бот выключен»…).
    private func send() {
        isSending = true
        Task {
            defer { isSending = false }
            do {
                let updated = try await api.sendSaleReceipt(id: sale.id)
                onSent(updated)
                sentCount += 1
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}
