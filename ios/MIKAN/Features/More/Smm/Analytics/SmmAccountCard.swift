import Charts
import SwiftUI

/// One platform account (Titan `PlatformCard`): followers and their change, reach and engagement of the window,
/// the daily chart, what works (formats, weekdays, hours, top posts), Instagram's audience and the collection error.
struct SmmAccountCard: View {
    let account: SmmAccount
    let window: SmmAnalyticsWindow
    /// This account's days.
    let history: [SmmHistoryPoint]
    let insight: SmmPlatformInsight?
    let timeZone: TimeZone

    var body: some View {
        let summary = SmmAccountSummary(account: account, history: history, window: window, timeZone: timeZone)
        VStack(alignment: .leading, spacing: 16) {
            header(summary)
            switch account.platform {
            case .instagram: instagram(summary)
            case .telegram: telegram(summary)
            default: EmptyView()
            }
            if let insight {
                SmmInsightBlocks(insight: insight, timeZone: timeZone)
            }
            if account.platform == .instagram, let audience = account.stats.audience, !audience.isEmpty {
                SmmAudienceBlock(audience: audience)
            }
            if let error = account.statsError.nonEmpty {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
        }
        .cardStyle()
    }

    private func header(_ summary: SmmAccountSummary) -> some View {
        HStack(spacing: 12) {
            SmmPlatformBadge(account.platform, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(account.title.nonEmpty ?? account.handle.nonEmpty ?? account.platform.title)
                    .font(.headline)
                    .lineLimit(1)
                Text(account.platform.title)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 2) {
                Text(summary.followers.map(SmmText.count) ?? "—")
                    .font(.title2.weight(.bold))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                Text(deltaText(summary.delta))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(deltaColor(summary.delta))
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func deltaText(_ delta: Int?) -> String {
        guard let delta else { return "подписчиков" }
        return "\(delta >= 0 ? "+" : "−")\(SmmText.count(abs(delta))) за \(window.days) дн."
    }

    private func deltaColor(_ delta: Int?) -> Color {
        guard let delta else { return .secondary }
        return delta >= 0 ? .green : .red
    }

    @ViewBuilder
    private func instagram(_ summary: SmmAccountSummary) -> some View {
        let period = summary.period
        SmmMetricGrid(metrics: [
            SmmMetric("Охват", period?.reach),
            SmmMetric("Просмотры", period?.views),
            SmmMetric("Вовлечённость", summary.engagement, suffix: "%"),
            SmmMetric("Взаимодействия", period?.interactions),
            SmmMetric("Визиты профиля", period?.profileViews),
            SmmMetric("Переходы по ссылке", period?.linkTaps),
            SmmMetric("Новые подписчики", period?.follows),
            SmmMetric("Отписки", period?.unfollows),
            SmmMetric("Ответы на сторис", period?.replies),
        ])
        if summary.reachSeries.count > 2 {
            VStack(alignment: .leading, spacing: 8) {
                SmmBlockTitle("Охват по дням")
                SmmDailyBars(points: summary.reachSeries, title: "Охват")
            }
        }
    }

    @ViewBuilder
    private func telegram(_ summary: SmmAccountSummary) -> some View {
        let stats = account.stats.tg
        SmmMetricGrid(metrics: [
            SmmMetric("Просмотров на пост", stats?.avgViews),
            SmmMetric("ERR — доля подписчиков, видящих пост", stats?.err, suffix: "%"),
            SmmMetric("Постов за 30 дней", stats?.posts30),
            SmmMetric("Просмотров за 30 дней", stats?.views30),
            SmmMetric("Реакций на пост", stats?.avgReactions),
        ])
        if summary.followerSeries.count > 2 {
            VStack(alignment: .leading, spacing: 8) {
                SmmBlockTitle("Подписчики по дням")
                SmmFollowersChart(points: summary.followerSeries)
            }
        }
    }
}

/// Daily bars from zero (Instagram reach).
struct SmmDailyBars: View {
    let points: [SmmDayValue]
    let title: String

    var body: some View {
        Chart(points) { point in
            BarMark(x: .value("День", point.date, unit: .day), y: .value(title, point.value))
                .foregroundStyle(Color.accentColor.gradient)
                .cornerRadius(3)
        }
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let number = value.as(Int.self) { Text(SmmText.count(number)) }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 5)) { _ in
                AxisGridLine()
                AxisValueLabel(format: .dateTime.day().month(.abbreviated), centered: true)
            }
        }
        .frame(height: 140)
        .accessibilityLabel(rangeLabel)
    }

    private var rangeLabel: String {
        let values = points.map(\.value)
        return "\(title) по дням: от \(SmmText.count(values.min() ?? 0)) до \(SmmText.count(values.max() ?? 0))"
    }
}

/// Followers by day as a line over their own range, not from zero (Titan draws them from the minimum too).
struct SmmFollowersChart: View {
    let points: [SmmDayValue]

    private var domain: ClosedRange<Int> {
        let values = points.map(\.value)
        let low = values.min() ?? 0
        let high = values.max() ?? 1
        let pad = max((high - low) / 5, 1)
        return max(low - pad, 0)...(high + pad)
    }

    var body: some View {
        let domain = domain
        Chart(points) { point in
            AreaMark(
                x: .value("День", point.date, unit: .day),
                yStart: .value("Подписчики", domain.lowerBound),
                yEnd: .value("Подписчики", point.value)
            )
            .foregroundStyle(LinearGradient(
                colors: [Color.accentColor.opacity(0.25), Color.accentColor.opacity(0.02)],
                startPoint: .top, endPoint: .bottom
            ))
            .interpolationMethod(.monotone)
            LineMark(x: .value("День", point.date, unit: .day), y: .value("Подписчики", point.value))
                .foregroundStyle(Color.accentColor)
                .lineStyle(StrokeStyle(lineWidth: 2))
                .interpolationMethod(.monotone)
        }
        .chartYScale(domain: domain)
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let number = value.as(Int.self) { Text(SmmText.count(number)) }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 5)) { _ in
                AxisGridLine()
                AxisValueLabel(format: .dateTime.day().month(.abbreviated), centered: true)
            }
        }
        .frame(height: 140)
        .accessibilityLabel("Подписчики по дням: от \(SmmText.count(points.first?.value ?? 0)) до \(SmmText.count(points.last?.value ?? 0))")
    }
}

nonisolated extension SmmAudience {
    var isEmpty: Bool { ages.isEmpty && genders.isEmpty && cities.isEmpty }
}

/// Instagram followers by age (bars with shares), gender and city (Titan `Audience`).
struct SmmAudienceBlock: View {
    let audience: SmmAudience

    private static let cityCount = 5

    private func share(_ value: Double, of list: [SmmAudienceSlice]) -> Int {
        let total = max(list.reduce(0) { $0 + $1.value }, 1)
        return Int((value / total * 100).rounded())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SmmBlockTitle("Аудитория")
            if !audience.ages.isEmpty {
                let top = audience.ages.map(\.value).max() ?? 0
                SmmHorizontalBars(items: audience.ages.map { slice in
                    SmmBarItem(
                        id: slice.label, label: slice.label, value: slice.value,
                        note: "\(share(slice.value, of: audience.ages))%", isStrong: slice.value == top
                    )
                })
            }
            if !audience.genders.isEmpty {
                Text(audience.genders.map { "\($0.label) \(share($0.value, of: audience.genders))%" }.joined(separator: " · "))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if !audience.cities.isEmpty {
                let cities = audience.cities.prefix(Self.cityCount)
                    .map { "\($0.label) \(share($0.value, of: audience.cities))%" }
                    .joined(separator: ", ")
                Text("Города: \(cities)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
