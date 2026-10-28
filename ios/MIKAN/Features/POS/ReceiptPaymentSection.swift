import SwiftUI

/// «Оплата»: big buttons for the method — cash, transfer, an SBP QR code when the server has Tochka configured — or
/// «Разделить». One method takes what is due automatically (cash adds «Получено» and the change); the split is typed.
/// A receipt covered by the prepayment, bonuses and certificates needs no method at all.
struct ReceiptPaymentSection: View {
    @Environment(CartStore.self) private var cart
    @Environment(ReferenceStore.self) private var reference

    /// QR shows once the server says it takes QR payments, or while the cart already uses it.
    private var qrShown: Bool { reference.qrPaymentsEnabled || cart.split.qr > 0 }

    var body: some View {
        Section {
            if cart.isPaidInFull {
                Label(
                    CheckoutPaidText.fullyPaid(
                        deposit: cart.depositApplied, bonus: cart.bonusApplied, certificate: cart.certificatesApplied
                    ),
                    systemImage: "checkmark.seal.fill"
                )
                .font(.headline)
                .foregroundStyle(.green)
                .frame(minHeight: 44)
            } else {
                PaymentModeButtons(qrEnabled: qrShown)
                    .listRowInsets(EdgeInsets(top: 10, leading: 10, bottom: 10, trailing: 10))
                switch cart.paymentMode {
                case .single(let method):
                    if method == .cash, cart.amountDue > 0 {
                        CashTenderRows()
                    }
                case .split:
                    SplitPaymentRows(methods: PaymentMethod.accepted(qrEnabled: qrShown))
                }
            }
        } header: {
            Text("Оплата")
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                if cart.paymentMode == .split, cart.depositApplied + cart.creditsApplied > 0, !cart.isPaidInFull {
                    Text("Распределите \(Money.format(cart.amountDue)) — сумму к оплате без предоплаты, бонусов и сертификатов.")
                }
                if cart.split.qr > 0 {
                    Text("Клиент оплатит \(Money.format(cart.split.qr)) через СБП по QR-коду на экране. Продажа проведётся, как только банк подтвердит оплату.")
                }
            }
        }
    }
}

private struct PaymentModeButtons: View {
    @Environment(CartStore.self) private var cart
    let qrEnabled: Bool

    private static let spacing: CGFloat = 8

    /// Four buttons in two rows; three fit one row.
    private var rows: [[PaymentMode]] {
        let modes = PaymentMode.choices(qrEnabled: qrEnabled)
        let columns = modes.count > 3 ? 2 : max(1, modes.count)
        return stride(from: 0, to: modes.count, by: columns).map { Array(modes[$0..<min($0 + columns, modes.count)]) }
    }

    var body: some View {
        VStack(spacing: Self.spacing) {
            ForEach(rows, id: \.self) { row in
                HStack(spacing: Self.spacing) {
                    ForEach(row, id: \.self) { mode in
                        button(for: mode)
                    }
                }
            }
        }
        .sensoryFeedback(.selection, trigger: cart.paymentMode)
    }

    private func button(for mode: PaymentMode) -> some View {
        let isSelected = cart.paymentMode == mode
        return Button {
            withAnimation(.snappy) { cart.selectPaymentMode(mode) }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: mode.symbol)
                Text(mode.title)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .font(.headline)
            .foregroundStyle(isSelected ? Color.white : Color.primary)
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(isSelected ? Color.accentColor : Color(.tertiarySystemFill), in: .rect(cornerRadius: 16))
            .contentShape(.rect(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

nonisolated extension PaymentMode {
    var symbol: String {
        switch self {
        case .single(let method): method.symbol
        case .split: "square.split.2x1"
        }
    }
}

// MARK: - Cash

/// «Получено»: the exact amount or round banknotes in one tap (or typed), and the change in large type. Display only:
/// the sale always records the exact due amount.
private struct CashTenderRows: View {
    @Environment(CartStore.self) private var cart

    var body: some View {
        @Bindable var cart = cart
        VStack(alignment: .leading, spacing: 8) {
            Text("Получено от клиента")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                ForEach(CashTender.suggestions(for: cart.amountDue), id: \.self) { amount in
                    tenderChip(amount)
                }
            }
        }
        .padding(.vertical, 4)
        NumberField.optionalMoney("Другая сумма", value: $cart.cashReceived)
        changeRow
    }

    private func tenderChip(_ amount: Int) -> some View {
        let isExact = amount == cart.amountDue
        let isSelected = cart.cashReceived == amount
        return Button {
            cart.cashReceived = isSelected ? nil : amount
        } label: {
            Text(isExact ? "Без сдачи" : Money.format(amount))
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .tint(isSelected ? Color.accentColor : Color.secondary)
        .sensoryFeedback(.selection, trigger: isSelected)
        .accessibilityLabel(isExact ? "Получено без сдачи" : "Получено \(Money.format(amount))")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    @ViewBuilder
    private var changeRow: some View {
        if let change = cart.cashChange {
            HStack(alignment: .firstTextBaseline) {
                Text("Сдача").font(.title3.weight(.semibold))
                Spacer(minLength: 8)
                MoneyText(change)
                    .font(.system(.title, design: .rounded).weight(.bold))
                    .foregroundStyle(change > 0 ? Theme.mandarinDeep : Color.primary)
                    .contentTransition(.numericText(value: Double(change)))
                    .animation(.snappy, value: change)
            }
            .accessibilityElement(children: .combine)
        } else if let received = cart.cashReceived, !cart.isCashReceivedEnough {
            Label("Не хватает \(Money.format(cart.amountDue - received))", systemImage: "exclamationmark.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.red)
                .monospacedDigit()
        }
    }
}

// MARK: - Split

private struct SplitPaymentRows: View {
    @Environment(CartStore.self) private var cart
    let methods: [PaymentMethod]

    var body: some View {
        @Bindable var cart = cart
        ForEach(methods) { method in
            NumberField.money(method.title, value: $cart.manualSplit[method], systemImage: method.symbol)
        }
        if cart.remaining != 0 {
            RemainderChips(methods: methods, remaining: cart.remaining)
        }
        RemainingIndicator(remaining: cart.remaining)
    }
}

/// «Остаток наличными» etc.: moves what is left (or overpaid) into one method with a tap.
private struct RemainderChips: View {
    @Environment(CartStore.self) private var cart
    let methods: [PaymentMethod]
    let remaining: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(remaining > 0 ? "Добавить остаток \(Money.format(remaining)):" : "Убрать лишние \(Money.format(-remaining)) из:")
                .font(.caption)
                .foregroundStyle(.secondary)
                .monospacedDigit()
            HStack(spacing: 8) {
                ForEach(methods) { method in
                    Button {
                        withAnimation(.snappy) { cart.fillRemaining(with: method) }
                    } label: {
                        Text(method.instrumentalTitle)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .frame(maxWidth: .infinity, minHeight: 36)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .disabled(remaining < 0 && cart.manualSplit[method] == 0)
                    .accessibilityLabel(remaining > 0 ? "Остаток \(method.instrumental)" : "Убрать лишнее из «\(method.title)»")
                }
            }
        }
        .padding(.vertical, 4)
    }
}

private struct RemainingIndicator: View {
    let remaining: Int

    var body: some View {
        Group {
            if remaining == 0 {
                Label("Сумма распределена", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else if remaining > 0 {
                Label("Осталось распределить: \(Money.format(remaining))", systemImage: "exclamationmark.circle.fill")
                    .foregroundStyle(.orange)
            } else {
                Label("Лишние \(Money.format(-remaining)) — уменьшите оплату", systemImage: "xmark.circle.fill")
                    .foregroundStyle(.red)
            }
        }
        .font(.subheadline.weight(.semibold))
        .monospacedDigit()
        .contentTransition(.numericText())
        .animation(.snappy, value: remaining)
    }
}
