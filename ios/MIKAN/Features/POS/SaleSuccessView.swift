import SwiftUI

/// After a sale: a big check mark and total, the change to give in large type, what was sold, the receipt in the
/// client's Telegram, certificates issued and bonuses earned; «Новая продажа» or «Готово».
struct SaleSuccessView: View {
    let outcome: SaleOutcome
    let onNewSale: () async throws -> Void
    let onDone: () -> Void

    @State private var isStartingNewSale = false
    @State private var errorMessage: String?

    private var sale: Sale { outcome.sale }

    var body: some View {
        List {
            SaleSuccessHero(sale: sale, cashChange: outcome.cashChange)
            SaleReceiptDeliverySection(sale: sale)
            SaleSuccessItemsSection(sale: sale)
            SaleBonusEarnedSection(sale: sale)
            IssuedCertificatesSection(sale: sale)
            notes
        }
        .navigationTitle("Продажа проведена")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaBar(edge: .bottom) { buttons }
        .errorAlert($errorMessage, title: "Чек не открыт")
    }

    @ViewBuilder
    private var notes: some View {
        if outcome.depositRemainder > 0 || outcome.completedVisit {
            Section {
                if outcome.completedVisit {
                    Label("Запись завершена", systemImage: "checkmark.circle")
                    if outcome.scheduledMessages > 0 {
                        Label(
                            "Памятка по уходу: " + Plural.count(outcome.scheduledMessages, one: "сообщение", few: "сообщения", many: "сообщений"),
                            systemImage: "paperplane"
                        )
                    }
                }
                if outcome.depositRemainder > 0 {
                    Label(
                        "Остаток предоплаты \(Money.format(outcome.depositRemainder)) остался за записью — верните его клиенту в карточке записи.",
                        systemImage: "info.circle"
                    )
                    .font(.subheadline)
                }
            }
        }
    }

    private var buttons: some View {
        HStack(spacing: 12) {
            Button(action: startNewSale) {
                ZStack {
                    Label("Новая продажа", systemImage: "plus").opacity(isStartingNewSale ? 0 : 1)
                    if isStartingNewSale { ProgressView() }
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
            }
            .buttonStyle(.glass)
            .disabled(isStartingNewSale)
            .needsConnection()
            Button(action: onDone) {
                Text("Готово")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
            }
            .buttonStyle(.glassProminent)
            .disabled(isStartingNewSale)
        }
        .controlSize(.large)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private func startNewSale() {
        isStartingNewSale = true
        Task {
            defer { isStartingNewSale = false }
            do {
                try await onNewSale()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

/// Check mark, number and total; the change to give back in large type when the client paid cash with more.
private struct SaleSuccessHero: View {
    let sale: Sale
    let cashChange: Int?

    @State private var bounces = false

    var body: some View {
        Section {
            VStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(.green)
                    .symbolEffect(.bounce, value: bounces)
                    .onAppear { bounces = true }
                    .accessibilityHidden(true)
                Text("Продажа №\(sale.number)").font(.title3.weight(.semibold))
                MoneyText(sale.total).font(.system(.largeTitle, design: .rounded).weight(.bold))
                if let methods = PaymentText.methods(sale.payments) {
                    Text("Оплачено \(methods)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                if let cashChange, cashChange > 0 {
                    ChangeToGive(amount: cashChange)
                        .padding(.top, 6)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .accessibilityElement(children: .combine)
        }
        .listRowBackground(Color.clear)
    }
}

/// «Сдача 500 ₽» — the number the cashier hands back, as large as the screen allows.
private struct ChangeToGive: View {
    let amount: Int

    var body: some View {
        VStack(spacing: 2) {
            Label("Сдача", systemImage: "banknote")
                .font(.headline)
            Text(Money.format(amount))
                .font(.system(size: 56, weight: .bold, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.5)
        }
        .foregroundStyle(Theme.mandarinDeep)
        .padding(.vertical, 14)
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity)
        .background(Theme.mandarin.opacity(0.14), in: .rect(cornerRadius: Theme.cardRadius))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Сдача \(Money.format(amount))")
    }
}

/// What was sold, one short line each.
private struct SaleSuccessItemsSection: View {
    let sale: Sale

    var body: some View {
        Section {
            ForEach(sale.items) { item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    SizedItemTitle(name: item.name, size: item.variantName)
                    if item.quantity > 1 {
                        Text("× \(item.quantity)")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    Spacer(minLength: 8)
                    MoneyText(item.total)
                }
                .font(.subheadline)
                .accessibilityElement(children: .combine)
            }
            if sale.discount > 0 {
                LabeledContent("Скидка") { Text("−" + Money.format(sale.discount)).monospacedDigit() }
                    .font(.subheadline)
            }
        } header: {
            Text(sale.client.map { "Чек · \($0.fullName)" } ?? "Чек")
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        SaleSuccessView(
            outcome: SaleOutcome(
                sale: PreviewData.sale, cashChange: 500, depositRemainder: 0, completedVisit: true, scheduledMessages: 3
            ),
            onNewSale: {},
            onDone: {}
        )
    }
    .previewEnvironment()
}
#endif
