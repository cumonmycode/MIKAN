import SwiftUI

/// «Ценность клиента»: over all time up to the end of the period — revenue and visits per client and how much of the
/// revenue the top 10 % of clients bring.
struct GrowthValueCard: View {
    let value: GrowthValue

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            AnalyticsCardTitle(
                title: "Ценность клиента",
                systemImage: "person.crop.circle.badge.checkmark",
                caption: "За всё время до конца периода · клиентов с визитами или покупками: \(value.clientsWithVisits)"
            )
            LazyVGrid(columns: columns, alignment: .leading, spacing: 12) {
                tile("Выручка на клиента", Money.format(value.averageRevenuePerClient), "Без бонусов, проданных сертификатов и возвратов")
                tile("Визитов на клиента", GrowthText.decimal(value.averageVisitsPerClient), "Завершённых записей в среднем")
                tile("Доля топ-10 %", ReportText.percent(value.top10PercentShare), "Выручки приносят 10 % лучших клиентов")
            }
        }
        .cardStyle()
    }

    private func tile(_ title: String, _ number: String, _ explanation: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(number)
                .font(.title3.weight(.bold))
                .monospacedDigit()
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            Text(explanation).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(.tertiarySystemGroupedBackground), in: .rect(cornerRadius: 14))
        .accessibilityElement(children: .combine)
    }
}

/// «Откуда новые клиенты»: the new clients of the period by the source on their card, with the revenue they brought.
struct GrowthSourcesCard: View {
    let sources: [GrowthSource]

    private var sorted: [GrowthSource] { GrowthText.sortedSources(sources) }
    private var total: Int { sources.reduce(0) { $0 + $1.newClients } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            AnalyticsCardTitle(
                title: "Откуда новые клиенты",
                systemImage: "point.3.connected.trianglepath.dotted",
                caption: "Источник из карточки клиента и выручка от новых клиентов за период"
            )
            if sources.isEmpty {
                Text("Новых клиентов за период не было").font(.subheadline).foregroundStyle(.secondary)
            }
            AnalyticsTopList(items: sorted) { index, source in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Circle().fill(AnalyticsPalette.color(index)).frame(width: 8, height: 8)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(GrowthText.sourceTitle(source.source))
                            Text(GrowthText.clients(source.newClients)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        MoneyText(source.revenue).fontWeight(.semibold)
                        Text(GrowthText.conversion(source.newClients, of: total))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                            .frame(minWidth: 40, alignment: .trailing)
                    }
                    .font(.subheadline)
                    ProgressView(value: GrowthText.fraction(source.newClients, of: total))
                        .tint(AnalyticsPalette.color(index))
                }
                .accessibilityElement(children: .combine)
            }
            if !sources.isEmpty {
                AnalyticsHint(text: "Процент — доля новых клиентов. Источник заполняется в карточке клиента.")
            }
        }
        .cardStyle()
    }
}

#if DEBUG
#Preview {
    ScrollView {
        VStack(spacing: 16) {
            GrowthValueCard(value: PreviewData.growth.value)
            GrowthSourcesCard(sources: PreviewData.growth.sources)
        }
        .padding()
    }
    .background { AuraBackground() }
}
#endif
