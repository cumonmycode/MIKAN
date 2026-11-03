import SwiftUI

/// One receipt line up close: its price and quantity (a product up to the stock of its size), or a gift certificate's
/// nominal and recipient; «Удалить из чека». Changes go straight into the cart.
struct ReceiptLineSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(CartStore.self) private var cart
    /// The line as it was opened; shown if it vanishes meanwhile (the receipt was reloaded from another phone).
    let initial: CartLine

    private static let serviceQuantityLimit = 99

    private var current: CartLine? { cart.lines.first { $0.id == initial.id } }

    private var line: Binding<CartLine> {
        Binding(
            get: { current ?? initial },
            set: { updated in
                guard let index = cart.lines.firstIndex(where: { $0.id == updated.id }) else { return }
                cart.lines[index] = updated
            }
        )
    }

    /// Products cannot be sold beyond the stock of their size (the server answers `insufficient_stock`).
    private var quantityRange: ClosedRange<Int> {
        let line = line.wrappedValue
        guard let limit = cart.stockLimit(for: line) else { return 1...Self.serviceQuantityLimit }
        return 1...max(1, limit, line.quantity)
    }

    var body: some View {
        NavigationStack {
            Form {
                if line.wrappedValue.isCertificate {
                    Section {
                        CertificateLineEditor(line: line)
                    }
                } else {
                    Section {
                        NumberField.money("Цена за шт.", value: line.unitPrice)
                    }
                    Section {
                        QuantityStepper(quantity: line.quantity, range: quantityRange)
                    } footer: {
                        if let warning = cart.stockWarning(for: line.wrappedValue) {
                            Text(warning).foregroundStyle(.orange)
                        } else if let stock = line.wrappedValue.stock {
                            Text("На складе \(stock) шт этого размера.")
                        }
                    }
                }
                Section {
                    Button("Удалить из чека", systemImage: "trash", role: .destructive) {
                        cart.removeLine(id: initial.id)
                        dismiss()
                    }
                }
            }
            .navigationTitle(SizeLabel.fullName(name: line.wrappedValue.name, size: line.wrappedValue.sizeName))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Готово") { dismiss() }
                }
            }
            .onChange(of: current == nil) { _, isGone in
                if isGone { dismiss() }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// «− 2 +» with buttons big enough to hit without looking, and the line total next to it.
private struct QuantityStepper: View {
    @Binding var quantity: Int
    let range: ClosedRange<Int>

    var body: some View {
        HStack(spacing: 16) {
            Text("Количество")
            Spacer(minLength: 8)
            stepButton("Меньше", systemImage: "minus", to: quantity - 1)
            Text("\(quantity)")
                .font(.title2.weight(.bold))
                .monospacedDigit()
                .frame(minWidth: 36)
                .contentTransition(.numericText(value: Double(quantity)))
                .animation(.snappy, value: quantity)
            stepButton("Больше", systemImage: "plus", to: quantity + 1)
        }
        .frame(minHeight: 52)
        .sensoryFeedback(.selection, trigger: quantity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Количество")
        .accessibilityValue("\(quantity)")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: set(quantity + 1)
            case .decrement: set(quantity - 1)
            @unknown default: break
            }
        }
    }

    private func stepButton(_ title: String, systemImage: String, to value: Int) -> some View {
        Button(title, systemImage: systemImage) { set(value) }
            .labelStyle(.iconOnly)
            .font(.title3.weight(.semibold))
            .frame(width: 44, height: 44)
            .background(Color.accentColor.opacity(0.12), in: .circle)
            .buttonStyle(.borderless)
            .disabled(!range.contains(value))
    }

    private func set(_ value: Int) {
        guard range.contains(value) else { return }
        quantity = value
    }
}
