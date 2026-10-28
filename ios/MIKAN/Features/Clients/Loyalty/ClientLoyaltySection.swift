import SwiftUI

/// «Бонусы» on the client card: the balance, the nearest lot that burns, the birthday discount, the ledger and —
/// for the owner and admins — a manual adjustment. Hidden for a server without loyalty.
struct ClientLoyaltySection: View {
    @Environment(\.permissions) private var permissions
    let client: Client
    /// Reloads the card after an adjustment.
    let onChange: () async -> Void

    @State private var showsAdjust = false

    var body: some View {
        if let loyalty = client.loyalty {
            Section {
                LabeledContent {
                    Text(BonusText.count(loyalty.bonusBalance))
                        .font(.title3.weight(.bold))
                        .monospacedDigit()
                        .contentTransition(.numericText(value: Double(loyalty.bonusBalance)))
                } label: {
                    Label("На счёте", systemImage: PaymentLine.bonusSymbol)
                }
                if let expiring = loyalty.expiring, expiring.amount > 0 {
                    Label(BonusText.expiring(expiring), systemImage: "flame")
                        .font(.subheadline)
                        .foregroundStyle(.orange)
                        .monospacedDigit()
                }
                if let discount = loyalty.birthdayDiscount, discount.percent > 0 {
                    Text(birthdayText(discount))
                        .font(.subheadline)
                }
                NavigationLink {
                    ClientBonusHistoryView(client: client.ref) { await onChange() }
                } label: {
                    Label("История бонусов", systemImage: "list.bullet.rectangle")
                }
                if permissions.adjustsBonuses {
                    // The sheet hangs on this one row: on a section it would be attached to every row.
                    Button("Начислить или списать", systemImage: "plusminus.circle") { showsAdjust = true }
                        .sheet(isPresented: $showsAdjust) {
                            BonusAdjustSheet(clientId: client.id, balance: loyalty.bonusBalance) {
                                Task { await onChange() }
                            }
                        }
                }
            } header: {
                Text("Бонусы")
            }
        }
    }

    private func birthdayText(_ discount: BirthdayDiscount) -> String {
        guard let until = CalendarDay.date(from: discount.until) else {
            return "🎂 Скидка именинника \(discount.percent)%"
        }
        return "🎂 Скидка именинника \(discount.percent)% — до \(DateText.dayMonth(until))"
    }
}

#if DEBUG
#Preview {
    var client = PreviewData.ivan
    client.loyalty = PreviewData.loyalty
    return NavigationStack {
        List {
            ClientLoyaltySection(client: client) {}
        }
    }
    .previewEnvironment()
}
#endif
