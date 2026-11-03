import SwiftUI

/// «Бонусы и сертификаты» of the analytics: what was credited, spent and burnt in the period and what is left on the
/// accounts and certificates at its end. A part without a single non-zero number is left out.
struct AnalyticsLoyaltyCard: View {
    let loyalty: AnalyticsLoyalty

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            AnalyticsCardTitle(title: "Бонусы и сертификаты", systemImage: "gift", caption: "Операции за период, остатки — на его конец")
            if loyalty.hasBonuses {
                rows(AnalyticsLoyaltyText.bonusRows(loyalty), title: "Бонусы", symbol: PaymentLine.bonusSymbol) {
                    AnalyticsLoyaltyText.bonuses($0)
                }
            }
            if loyalty.hasBonuses && loyalty.hasCertificates {
                Divider()
            }
            if loyalty.hasCertificates {
                rows(AnalyticsLoyaltyText.certificateRows(loyalty), title: "Сертификаты", symbol: PaymentLine.certificateSymbol) {
                    Money.format($0)
                }
            }
        }
        .cardStyle()
    }

    private func rows(
        _ rows: [AnalyticsLoyaltyText.Row], title: String, symbol: String, value: @escaping (Int) -> String
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: symbol)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(rows) { row in
                AnalyticsValueRow(title: row.title, value: value(row.amount), detail: row.detail, isEmphasized: row.isBalance)
            }
        }
    }
}

/// Rows and numbers of «Бонусы и сертификаты» (the card and the CSV export).
nonisolated enum AnalyticsLoyaltyText {
    struct Row: Hashable, Identifiable, Sendable {
        let title: String
        let amount: Int
        /// What the number means, in a few words.
        let detail: String
        /// A balance at the end of the period, not an operation of it.
        var isBalance = false

        var id: String { title }
    }

    static func bonusRows(_ loyalty: AnalyticsLoyalty) -> [Row] {
        [
            Row(title: "Начислено", amount: loyalty.bonusEarned, detail: "Кешбэк, подарки и ручные начисления за вычетом возвратов"),
            Row(title: "Оплачено бонусами", amount: loyalty.bonusSpent, detail: "Работают как скидка и в выручку не входят"),
            Row(title: "Сгорело", amount: loyalty.bonusExpired, detail: "Клиенты не успели потратить до конца срока"),
            Row(title: "На счетах клиентов", amount: loyalty.bonusOutstanding, detail: "Остаток на конец периода", isBalance: true),
        ]
    }

    static func certificateRows(_ loyalty: AnalyticsLoyalty) -> [Row] {
        [
            Row(title: "Продано", amount: loyalty.certificatesSold, detail: "Деньги получены, в выручку попадут при оплате сертификатом"),
            Row(title: "Оплачено сертификатами", amount: loyalty.certificatesRedeemed, detail: "Уже вошло в выручку чеков"),
            Row(title: "Сгорело", amount: loyalty.certificatesExpired, detail: "Истёк срок действия"),
            Row(title: "Аннулировано", amount: loyalty.certificatesCancelled, detail: "Отменены владельцем или возвратом продажи"),
            Row(title: "Не потрачено", amount: loyalty.certificatesOutstanding, detail: "Остаток на сертификатах на конец периода", isBalance: true),
        ]
    }

    /// «1 200 бонусов», «−50 бонусов» (manual adjustments can take more than was credited).
    static func bonuses(_ amount: Int) -> String {
        let sign = amount < 0 ? Money.minus : ""
        return sign + Money.group(amount.magnitude) + " " + Plural.word(amount, one: "бонус", few: "бонуса", many: "бонусов")
    }
}

#if DEBUG
#Preview {
    ScrollView {
        AnalyticsLoyaltyCard(loyalty: PreviewData.analytics.loyalty)
            .padding()
    }
    .background { AuraBackground() }
}
#endif
