import SwiftUI

/// «Подарочный сертификат» at the till: the nominal and who it is for. The line goes to the receipt; the sale issues
/// the certificate with its code.
struct CertificateSaleSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    @Environment(CartStore.self) private var cart

    @State private var amount: Int?
    @State private var recipientName = ""
    @FocusState private var focusesRecipient: Bool

    private var isValid: Bool {
        (amount.map(CertificateRules.isValidAmount) ?? false)
            && recipientName.trimmed.count <= CertificateRules.recipientNameLimit
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    NumberField.optionalMoney("Номинал", value: $amount, placeholder: "0")
                    AmountChips(selection: $amount)
                } footer: {
                    if let amount, !CertificateRules.isValidAmount(amount) {
                        Text(CertificateRules.amountHint).foregroundStyle(.red)
                    } else {
                        Text(CertificateRules.amountHint)
                    }
                }
                Section {
                    TextField("Например, Маше", text: $recipientName)
                        .textInputAutocapitalization(.words)
                        .focused($focusesRecipient)
                        .submitLabel(.done)
                } header: {
                    Text("Кому")
                } footer: {
                    Text(footer)
                }
                if cart.acceptsCredits && (cart.bonusRequested > 0 || !cart.certificateCharges.isEmpty) {
                    Section {
                        Label("Чек с сертификатом оплачивается только деньгами: бонусы и другие сертификаты в нём не спишутся.", systemImage: "info.circle")
                            .font(.subheadline)
                    }
                }
            }
            .navigationTitle("Подарочный сертификат")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Добавить", action: add).disabled(!isValid)
                }
            }
            // Only for the validity line of the footer.
            .task {
                if cart.loyaltyRules == nil { await CheckoutLoyaltyLoading.loadRules(api: api, cart: cart) }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var footer: String {
        let validity = cart.loyaltyRules.map { CertificateRules.validityText(months: $0.certificateValidityMonths) }
        let parts = [
            "Имя будет на карточке сертификата (до \(CertificateRules.recipientNameLimit) символов). Код появится после оплаты.",
            validity.map { "\($0)." },
        ]
        return parts.compactMap { $0 }.joined(separator: " ")
    }

    private func add() {
        guard let amount, isValid else { return }
        cart.addCertificate(amount: amount, recipientName: recipientName)
        dismiss()
    }
}

/// Quick nominals: «1 000 ₽», «3 000 ₽», …
private struct AmountChips: View {
    @Binding var selection: Int?

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(CertificateRules.suggestedAmounts, id: \.self) { amount in
                    Button {
                        selection = amount
                    } label: {
                        Text(Money.format(amount)).monospacedDigit()
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .tint(selection == amount ? .accentColor : .secondary)
                }
            }
        }
        .scrollIndicators(.hidden)
        .sensoryFeedback(.selection, trigger: selection)
    }
}

/// A certificate line of the receipt or checkout: its nominal and recipient (quantity is always 1, no discount).
struct CertificateLineEditor: View {
    @Binding var line: CartLine

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: line.symbol)
                    .foregroundStyle(Color.accentColor)
                    .accessibilityHidden(true)
                Text(line.name).font(.body.weight(.medium))
                Spacer(minLength: 8)
                MoneyText(line.total)
                    .font(.body.weight(.semibold))
                    .contentTransition(.numericText(value: Double(line.total)))
                    .animation(.snappy, value: line.total)
            }
            NumberField.money("Номинал", value: $line.unitPrice)
                .font(.subheadline)
            TextField("Кому (необязательно)", text: $line.recipientName)
                .font(.subheadline)
                .textInputAutocapitalization(.words)
            if !CertificateRules.isValidAmount(line.unitPrice) {
                Label(CertificateRules.amountHint, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.orange)
            } else if line.recipientName.trimmed.count > CertificateRules.recipientNameLimit {
                Label("Имя — не длиннее \(CertificateRules.recipientNameLimit) символов", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.orange)
            } else {
                Text("Код появится после оплаты. Скидка на сертификат не действует.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

#if DEBUG
#Preview {
    CertificateSaleSheet()
        .previewEnvironment()
}
#endif
