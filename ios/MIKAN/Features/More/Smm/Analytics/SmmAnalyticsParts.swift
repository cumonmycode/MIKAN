import Charts
import SwiftUI

/// The window of the account cards: 7 or 30 days.
nonisolated enum SmmAnalyticsWindow: Int, CaseIterable, Identifiable, Sendable {
    case week = 7
    case month = 30

    var id: Int { rawValue }
    var days: Int { rawValue }
    var title: String { "\(rawValue) дней" }
}

/// A day of an account's history on a chart.
nonisolated struct SmmDayValue: Identifiable, Hashable, Sendable {
    /// `YYYY-MM-DD`.
    let day: String
    /// Noon of that day on the device calendar — for the chart's date axis.
    let date: Date
    let value: Int

    var id: String { day }
}

/// What the account card shows for the window (Titan `PlatformCard`): followers now and their change, the daily
/// series, the Instagram period and its engagement.
nonisolated struct SmmAccountSummary: Sendable {
    let followers: Int?
    /// Change of followers over the window; `nil` without two days of history.
    let delta: Int?
    let followerSeries: [SmmDayValue]
    let reachSeries: [SmmDayValue]
    let period: SmmIgPeriod?
    /// Engaged accounts to reach, %.
    let engagement: Double?

    init(account: SmmAccount, history: [SmmHistoryPoint], window: SmmAnalyticsWindow, timeZone: TimeZone, now: Date = .now) {
        let from = SmmText.dayKey(of: now.addingTimeInterval(-Double(window.days) * 86_400), in: timeZone)
        let ordered = history.sorted { $0.day < $1.day }
        let withFollowers = ordered.filter { $0.followers != nil }
        let inWindow = withFollowers.filter { $0.day >= from }
        let first = inWindow.first?.followers
        let last = withFollowers.last?.followers ?? account.followers
        followers = last
        if let first, let last, inWindow.count > 1 {
            delta = last - first
        } else {
            delta = nil
        }
        followerSeries = inWindow.compactMap { point in point.followers.flatMap { Self.value(point.day, $0) } }
        reachSeries = ordered
            .filter { $0.day >= from }
            .compactMap { point in point.reach.flatMap { Self.value(point.day, $0) } }
        let period = window == .week ? account.stats.period7 : account.stats.period30
        self.period = period
        if let reach = period?.reach, reach > 0, let engaged = period?.engaged {
            engagement = (Double(engaged) / Double(reach) * 1000).rounded() / 10
        } else {
            engagement = nil
        }
    }

    private static func value(_ day: String, _ value: Int) -> SmmDayValue? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3,
              let date = Calendar.app.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
        else { return nil }
        return SmmDayValue(day: day, date: date, value: value)
    }
}

/// A number with its label in the metric grid; a missing value is not shown.
nonisolated struct SmmMetric: Identifiable, Sendable {
    let label: String
    let value: Double?
    var suffix = ""

    var id: String { label }

    init(_ label: String, _ value: Int?) {
        self.label = label
        self.value = value.map(Double.init)
    }

    init(_ label: String, _ value: Double?, suffix: String = "") {
        self.label = label
        self.value = value
        self.suffix = suffix
    }

    var text: String? {
        value.map { SmmNumber.text($0) + suffix }
    }
}

/// Russian numbers of the analytics: «12 345», «4,7».
nonisolated enum SmmNumber {
    static func text(_ value: Double) -> String {
        if value.rounded() == value, abs(value) < 1e12 {
            return SmmText.count(Int(value))
        }
        return value.formatted(.number.precision(.fractionLength(0...1)).locale(.app))
    }

    /// «+12%», «−3,5%».
    static func signedPercent(_ value: Double) -> String {
        (value >= 0 ? "+" : "−") + text(abs(value)) + "%"
    }

    /// «dd.MM» of a `YYYY-MM-DD` day.
    static func shortDay(_ day: String) -> String {
        let parts = day.split(separator: "-")
        guard parts.count == 3 else { return day }
        return "\(parts[2]).\(parts[1])"
    }
}

/// Grid of big numbers with captions (Titan `MetricGrid`); empty metrics are left out, nothing at all — no grid.
struct SmmMetricGrid: View {
    let metrics: [SmmMetric]

    private let columns = [GridItem(.adaptive(minimum: 96), spacing: 12, alignment: .topLeading)]

    var body: some View {
        let shown = metrics.compactMap { metric in metric.text.map { (id: metric.id, label: metric.label, text: $0) } }
        if !shown.isEmpty {
            LazyVGrid(columns: columns, alignment: .leading, spacing: 14) {
                ForEach(shown, id: \.id) { metric in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(metric.text)
                            .font(.title3.weight(.bold))
                            .monospacedDigit()
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)
                            .contentTransition(.numericText())
                        Text(metric.label)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

/// A bar of a horizontal bar chart: label on the left, number (or note) after the bar.
nonisolated struct SmmBarItem: Identifiable, Sendable {
    let id: String
    let label: String
    let value: Double
    var note: String?
    var isStrong = false
}

/// Horizontal bars (formats, ages — Titan `HBar`), the strongest in full accent, the rest dimmed.
struct SmmHorizontalBars: View {
    let items: [SmmBarItem]

    private static let rowHeight: CGFloat = 30

    var body: some View {
        let top = max(items.map(\.value).max() ?? 1, 1)
        Chart(items) { item in
            BarMark(x: .value("Значение", item.value), y: .value("Категория", item.label))
                .foregroundStyle(item.isStrong ? Color.accentColor.gradient : Color.accentColor.opacity(0.45).gradient)
                .cornerRadius(4)
                .annotation(position: .trailing, alignment: .leading, spacing: 6) {
                    Text(item.note ?? SmmNumber.text(item.value))
                        .font(.caption.weight(item.isStrong ? .semibold : .regular))
                        .monospacedDigit()
                        .foregroundStyle(item.isStrong ? .primary : .secondary)
                }
        }
        .chartXScale(domain: 0...(top * 1.3))
        .chartXAxis(.hidden)
        .chartYAxis {
            AxisMarks(position: .leading) { _ in
                AxisValueLabel().font(.caption)
            }
        }
        .frame(height: CGFloat(items.count) * Self.rowHeight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(items.map { "\($0.label): \($0.note ?? SmmNumber.text($0.value))" }.joined(separator: ", "))
    }
}

/// Small grey caps title of a block inside a card: «ОХВАТ ПО ДНЯМ».
struct SmmBlockTitle: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text.uppercased())
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .accessibilityAddTraits(.isHeader)
    }
}

/// How the marketer's forecasts come true (Titan `Accuracy`): inside the corridor, above, below.
struct SmmAccuracyCard: View {
    let accuracy: SmmAccuracy

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if accuracy.posts == 0 {
                Text("Когда посты маркетолога начнут выходить, здесь будет видно, сколько просмотров ждали и сколько получили. Прогноз считается по похожим постам площадки.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                SmmMetricGrid(metrics: [
                    SmmMetric("Постов с прогнозом", accuracy.posts),
                    SmmMetric("В коридоре прогноза", accuracy.inside),
                    SmmMetric("Выше прогноза", accuracy.above),
                    SmmMetric("Ниже прогноза", accuracy.below),
                ])
                if let ratio = accuracy.ratio {
                    Text("В среднем посты набирают \(Int((ratio * 100).rounded()))% от прогноза.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .cardStyle()
    }
}
