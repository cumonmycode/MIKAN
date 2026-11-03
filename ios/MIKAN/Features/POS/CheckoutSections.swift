import SwiftUI

struct SaleItemsSection: View {
    let sale: Sale

    var body: some View {
        Section("Позиции") {
            ForEach(sale.items) { item in
                HStack(alignment: .firstTextBaseline) {
                    if item.isCertificate {
                        Image(systemName: PaymentLine.certificateSymbol)
                            .foregroundStyle(Color.accentColor)
                            .accessibilityHidden(true)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        SizedItemTitle(name: item.name, size: item.variantName)
                        Text("\(item.quantity) × \(Money.format(item.price))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    Spacer()
                    MoneyText(item.total)
                }
                .accessibilityElement(children: .combine)
            }
            if sale.discount > 0 {
                LabeledContent("Подытог") { MoneyText(sale.subtotal) }
                LabeledContent("Скидка") { Text("−" + Money.format(sale.discount)).monospacedDigit() }
            }
            LabeledContent("Итого") { MoneyText(sale.total).fontWeight(.bold) }
        }
    }
}

/// How a sale was paid: the methods and the part covered by the appointment's prepayment.
struct SalePaymentsSection: View {
    let payments: Payments

    var body: some View {
        Section("Оплата") {
            ForEach(payments.paymentLines) { line in
                LabeledContent {
                    MoneyText(line.amount)
                } label: {
                    Label(line.title, systemImage: line.symbol)
                }
            }
        }
    }
}
