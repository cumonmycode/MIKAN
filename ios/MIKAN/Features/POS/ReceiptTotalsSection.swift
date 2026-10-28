import SwiftUI

/// The money of the receipt, compact: «Скидка» (tap to change; the birthday discount offered), the prepayment applied,
/// «Списать N бонусов», certificates paying it, and the big «К оплате» — what the payment methods take.
struct ReceiptTotalsSection: View {
    @Environment(CartStore.self) private var cart
    let onDiscount: () -> Void
    /// Opens the certificate lookup: for a new code (`nil`) or to change what a certificate in the receipt pays.
    let onCertificate: (String?) -> Void

    private var showsTotal: Bool { cart.depositApplied + cart.creditsApplied > 0 }

    var body: some View {
        Section {
            discountRow
            ReceiptBirthdayOffer()
            if cart.depositApplied > 0 {
                depositRow
            }
            ReceiptBonusRow()
            ReceiptCertificateRows(onLookup: onCertificate)
            if showsTotal {
                LabeledContent("Итого") { MoneyText(cart.total) }
                    .font(.subheadline)
            }
            dueRow
        } footer: {
            footer
        }
    }

    private var discountRow: some View {
        Button(action: onDiscount) {
            HStack {
                Label(cart.isBirthdayDiscountApplied ? "Скидка именинника" : "Скидка", systemImage: "tag")
                Spacer(minLength: 8)
                if cart.discount > 0 {
                    Text("−" + Money.format(cart.discount))
                        .monospacedDigit()
                        .foregroundStyle(cart.isDiscountValid ? Color.primary : Color.red)
                } else {
                    Text("Добавить").foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .tint(.primary)
    }

    /// «Предоплата −2 000 ₽ · внесена переводом 15 октября».
    private var depositRow: some View {
        LabeledContent {
            Text("−" + Money.format(cart.depositApplied))
                .monospacedDigit()
                .foregroundStyle(.green)
        } label: {
            Label(PaymentLine.depositTitle, systemImage: PaymentLine.depositSymbol)
            if let note = ReceiptDraft.depositReceivedNote(cart.appointment?.depositOperations ?? []) {
                Text(note)
            }
        }
    }

    private var dueRow: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("К оплате")
                .font(.title3.weight(.semibold))
            Spacer(minLength: 8)
            MoneyText(cart.amountDue)
                .font(.system(.title, design: .rounded).weight(.bold))
                .contentTransition(.numericText(value: Double(cart.amountDue)))
                .animation(.snappy, value: cart.amountDue)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !cart.isDiscountValid {
                Text(cart.sellsCertificate
                    ? "Скидка не может быть больше суммы чека без подарочного сертификата."
                    : "Скидка не может быть больше суммы чека.")
                    .foregroundStyle(.red)
            }
            if cart.depositRemainder > 0 {
                Text("Остаток предоплаты \(Money.format(cart.depositRemainder)) останется за записью — верните его клиенту в карточке записи.")
            }
            if cart.expectedCashback > 0 {
                Text("Бонусы за покупку: ≈ \(BonusText.count(cart.expectedCashback)).")
            }
        }
        .monospacedDigit()
    }
}

/// «🎂 Скидка именинника 10% · −350 ₽ [Применить]» while the client is inside their birthday window.
private struct ReceiptBirthdayOffer: View {
    @Environment(CartStore.self) private var cart

    var body: some View {
        if let discount = cart.birthdayDiscount, cart.birthdayDiscountAmount > 0, !cart.isBirthdayDiscountApplied {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("🎂 Скидка именинника \(discount.percent)%").font(.subheadline.weight(.semibold))
                    Text(ReceiptDiscountText.birthday(amount: cart.birthdayDiscountAmount, discount: discount))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                Spacer(minLength: 8)
                Button("Применить") {
                    withAnimation(.snappy) { cart.applyBirthdayDiscount() }
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .frame(minHeight: 44)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// «Списать 900 бонусов» — one switch for the most the receipt may take; the balance and what burns soon below it.
private struct ReceiptBonusRow: View {
    @Environment(CartStore.self) private var cart

    var body: some View {
        @Bindable var cart = cart
        if cart.activeLoyalty != nil, cart.loyaltyRules?.loyaltyEnabled == true, cart.bonusBalance > 0 {
            if cart.canSpendBonuses, cart.bonusLimit > 0 {
                Toggle(isOn: $cart.spendsBonuses.animation(.snappy)) {
                    Label {
                        Text("Списать \(BonusText.count(cart.bonusLimit))")
                            .monospacedDigit()
                        Text(balanceText)
                            .monospacedDigit()
                    } icon: {
                        Image(systemName: PaymentLine.bonusSymbol)
                    }
                }
                .frame(minHeight: 44)
                .sensoryFeedback(.selection, trigger: cart.spendsBonuses)
            } else {
                Label {
                    Text("На счёте \(BonusText.count(cart.bonusBalance))")
                        .monospacedDigit()
                    Text(cart.sellsCertificate
                        ? "Чек с подарочным сертификатом оплачивается только деньгами"
                        : "В этом чеке списать бонусы нельзя")
                } icon: {
                    Image(systemName: PaymentLine.bonusSymbol)
                }
                .foregroundStyle(.secondary)
            }
        }
    }

    /// «На счёте 1 200 бонусов · 500 бонусов сгорят 2 ноября».
    private var balanceText: String {
        let balance = "На счёте \(BonusText.count(cart.bonusBalance))"
        guard let expiring = cart.activeLoyalty?.expiring, expiring.amount > 0 else { return balance }
        return "\(balance) · \(BonusText.expiring(expiring))"
    }
}

/// Gift certificates paying the receipt (tap one to change the amount, × to drop it) and «Оплатить сертификатом».
private struct ReceiptCertificateRows: View {
    @Environment(CartStore.self) private var cart
    let onLookup: (String?) -> Void

    var body: some View {
        if cart.acceptsCredits {
            let amounts = cart.certificateAmounts
            ForEach(Array(cart.certificateCharges.enumerated()), id: \.element.id) { index, charge in
                chargeRow(charge, applied: amounts.indices.contains(index) ? amounts[index] : 0)
            }
            Button {
                onLookup(nil)
            } label: {
                HStack {
                    Label("Оплатить сертификатом", systemImage: PaymentLine.certificateSymbol)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            .tint(.primary)
            .disabled(cart.amountDue == 0)
        } else if !cart.certificateCharges.isEmpty {
            Label("Чек с подарочным сертификатом оплачивается только деньгами — выбранные сертификаты не спишутся.", systemImage: "info.circle")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private func chargeRow(_ charge: CertificateCharge, applied: Int) -> some View {
        HStack(spacing: 10) {
            Button {
                onLookup(charge.code)
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: PaymentLine.certificateSymbol)
                        .foregroundStyle(Color.accentColor)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(charge.code).font(.subheadline.weight(.medium).monospaced())
                        Text("Остаток \(Money.format(charge.balance))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    Spacer(minLength: 8)
                    Text("−" + Money.format(applied))
                        .monospacedDigit()
                        .foregroundStyle(.green)
                }
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Изменить сумму списания")
            Button("Убрать сертификат", systemImage: "xmark.circle.fill") {
                withAnimation(.snappy) { cart.removeCertificateCharge(code: charge.code) }
            }
            .labelStyle(.iconOnly)
            .font(.title3)
            .foregroundStyle(.secondary)
            .frame(width: 44, height: 44)
            .buttonStyle(.borderless)
        }
    }
}
