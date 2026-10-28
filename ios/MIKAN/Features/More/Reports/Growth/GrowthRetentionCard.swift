import SwiftUI

/// «Возвращаемость»: how many new clients of the period came back within 90 days, the usual gap between visits and
/// the cohort table — clients by the month of their first visit and the share that returned within 30 / 90 / 180 days.
struct GrowthRetentionCard: View {
    let retention: GrowthRetention

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            AnalyticsCardTitle(
                title: "Возвращаемость",
                systemImage: "arrow.uturn.backward.circle",
                caption: "Новый клиент — первый завершённый визит пришёлся на этот период"
            )
            headline
            AnalyticsValueRow(
                title: "В среднем между визитами",
                value: retention.averageDaysBetweenVisits.map(Plural.days) ?? "—",
                detail: "Для визитов периода — сколько дней прошло с прошлого визита клиента"
            )
            Divider()
            Text("Когорты по месяцу первого визита").font(.subheadline.weight(.semibold))
            GrowthCohortTable(cohorts: retention.cohorts)
            AnalyticsHint(text: "Доля клиентов месяца, вернувшихся за 30, 90 и 180 дней после первого визита. "
                + "Чем ярче ячейка, тем лучше. Полупрозрачные ещё набираются: прошло меньше дней.")
        }
        .cardStyle()
    }

    private var headline: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(ReportText.percent(retention.repeatRatePercent))
                .font(.largeTitle.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text("вернулись в течение 90 дней").font(.subheadline)
                Text("\(retention.returnedWithin90Days) из \(GrowthText.clients(retention.newClients)) — новых за период")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Month × 30 / 90 / 180 days, newest month first, each cell tinted by its share of returns.
struct GrowthCohortTable: View {
    let cohorts: [GrowthCohort]
    var now: Date = .now

    private var maximum: Double { GrowthHeatScale.maximum(cohorts) }

    var body: some View {
        Grid(alignment: .center, horizontalSpacing: 6, verticalSpacing: 6) {
            GridRow {
                Text("Месяц").gridColumnAlignment(.leading)
                Text("Новых")
                ForEach(GrowthHeatScale.windows, id: \.self) { days in
                    Text("\(days) дн.")
                }
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            ForEach(cohorts.reversed()) { cohort in
                GridRow {
                    Text(GrowthText.monthTitle(cohort.month))
                        .font(.subheadline)
                        .gridColumnAlignment(.leading)
                    Text("\(cohort.clients)")
                        .font(.subheadline.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(cohort.clients > 0 ? .primary : .tertiary)
                    ForEach(GrowthHeatScale.windows, id: \.self) { days in
                        GrowthCohortCell(cohort: cohort, days: days, maximum: maximum, now: now)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
    }
}

/// One cohort cell: «33 %» on a tint scaled to the table's best share; faded while the window is still open.
struct GrowthCohortCell: View {
    let cohort: GrowthCohort
    let days: Int
    let maximum: Double
    var now: Date = .now

    var body: some View {
        let share = GrowthHeatScale.share(cohort, days: days)
        let intensity = GrowthHeatScale.intensity(share, maximum: maximum)
        let isFinal = GrowthText.cohortWindowClosed(month: cohort.month, days: days, now: now)
        Text(share.map { GrowthText.wholePercent($0 * 100) } ?? "—")
            .font(.caption.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(share == nil ? AnyShapeStyle(.tertiary) : GrowthHeatScale.prefersLightText(intensity) ? AnyShapeStyle(.white) : AnyShapeStyle(.primary))
            .frame(maxWidth: .infinity, minHeight: 30)
            .background {
                if share != nil {
                    RoundedRectangle(cornerRadius: 8).fill(Color.accentColor.opacity(GrowthHeatScale.opacity(intensity)))
                }
            }
            .opacity(isFinal ? 1 : 0.55)
            .accessibilityLabel(accessibilityText(isFinal: isFinal))
    }

    private func accessibilityText(isFinal: Bool) -> String {
        let month = GrowthText.monthTitle(cohort.month)
        guard cohort.clients > 0 else { return "\(month), за \(days) дней: нет новых клиентов" }
        let pending = isFinal ? "" : ", ещё набирается"
        return "\(month), за \(days) дней вернулись \(cohort.returned(within: days)) из \(cohort.clients)\(pending)"
    }
}

#if DEBUG
#Preview {
    ScrollView {
        GrowthRetentionCard(retention: PreviewData.growth.retention)
            .padding()
    }
    .background { AuraBackground() }
}
#endif
