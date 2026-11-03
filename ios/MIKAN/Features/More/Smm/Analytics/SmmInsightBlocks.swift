import Charts
import SwiftUI

/// What works on the account (Titan `Insight`): formats by average views, weekdays and hours of publishing, the best
/// time in words and the top publications of 60 days.
struct SmmInsightBlocks: View {
    let insight: SmmPlatformInsight
    let timeZone: TimeZone

    /// Titan shows weekdays from three of them on and formats from two.
    private static let minWeekdays = 3
    private static let minHours = 3
    private static let minFormats = 2

    var body: some View {
        if insight.formats.count >= Self.minFormats {
            formats
        }
        if insight.weekdays.count >= Self.minWeekdays || insight.hours.count >= Self.minHours {
            SmmTimingBlock(
                weekdays: insight.weekdays.count >= Self.minWeekdays ? insight.weekdays : [],
                hours: insight.hours.count >= Self.minHours ? insight.hours : []
            )
        }
        if let tip = SmmInsightText.bestTime(insight) {
            Label {
                Text(tip).fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "clock.badge.checkmark").foregroundStyle(Color.accentColor)
            }
            .font(.footnote)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 14))
        }
        if !insight.top.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SmmBlockTitle("Лучшие публикации за 60 дней")
                ForEach(insight.top) { top in
                    SmmTopPostRow(top: top, timeZone: timeZone)
                }
            }
        }
    }

    private var formats: some View {
        let top = insight.formats.map(\.avgViews).max() ?? 0
        return VStack(alignment: .leading, spacing: 8) {
            SmmBlockTitle("Форматы · просмотров в среднем")
            SmmHorizontalBars(items: insight.formats.map { format in
                SmmBarItem(
                    id: format.id, label: "\(format.format.title) · \(format.posts)",
                    value: Double(format.avgViews), isStrong: format.avgViews == top
                )
            })
        }
    }
}

/// Average views by weekday or by hours of publishing, the best one highlighted (like «Когда покупают» in the
/// studio reports).
struct SmmTimingBlock: View {
    let weekdays: [SmmWeekdayInsight]
    let hours: [SmmHourInsight]

    private enum Mode: String, CaseIterable, Identifiable {
        case weekday, hour

        var id: String { rawValue }
        var title: String { self == .weekday ? "Дни недели" : "Часы" }
    }

    private struct Bar: Identifiable {
        let id: Int
        let label: String
        let views: Int
        let posts: Int
    }

    @State private var mode = Mode.weekday

    private var shownMode: Mode {
        if weekdays.isEmpty { return .hour }
        if hours.isEmpty { return .weekday }
        return mode
    }

    private var bars: [Bar] {
        switch shownMode {
        case .weekday:
            weekdays.map { Bar(id: $0.weekday, label: SmmInsightText.weekdayShort($0.weekday), views: $0.avgViews, posts: $0.posts) }
        case .hour:
            hours.map { Bar(id: $0.from, label: "\($0.from)–\($0.to)", views: $0.avgViews, posts: $0.posts) }
        }
    }

    var body: some View {
        let bars = bars
        let peak = bars.max { $0.views < $1.views }
        VStack(alignment: .leading, spacing: 8) {
            SmmBlockTitle(shownMode == .weekday ? "Дни недели · просмотров в среднем" : "Время выхода · просмотров в среднем")
            if !weekdays.isEmpty, !hours.isEmpty {
                Picker("Разбивка", selection: $mode) {
                    ForEach(Mode.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            Chart(bars) { bar in
                BarMark(x: .value(shownMode.title, bar.label), y: .value("Просмотры", bar.views))
                    .foregroundStyle(bar.id == peak?.id ? Color.accentColor.gradient : Color.accentColor.opacity(0.45).gradient)
                    .cornerRadius(4)
            }
            .chartYAxis {
                AxisMarks(position: .leading) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let number = value.as(Int.self) { Text(SmmText.count(number)) }
                    }
                }
            }
            .frame(height: 150)
            .accessibilityLabel(bars.map { "\($0.label): \(SmmText.count($0.views))" }.joined(separator: ", "))
        }
    }
}

/// A top publication of the platform: tap opens our post, or the platform's page for someone else's.
struct SmmTopPostRow: View {
    let top: SmmTopPost
    let timeZone: TimeZone

    var body: some View {
        if let postId = top.postId {
            NavigationLink(value: SmmRoute.post(id: postId)) { label }
                .buttonStyle(.plain)
        } else if let link = top.permalink.flatMap(URL.init(string:)) {
            Link(destination: link) { label }
                .buttonStyle(.plain)
        } else {
            label
        }
    }

    private var label: some View {
        HStack(spacing: 12) {
            SmmRemoteImage(path: top.thumb, placeholderSymbol: "text.alignleft")
                .frame(width: 44, height: 44)
                .clipShape(.rect(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(top.caption.nonEmpty ?? top.format.title)
                    .font(.subheadline)
                    .lineLimit(2)
                Text(meta)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }

    private var meta: String {
        var parts: [String] = []
        if let publishedAt = top.publishedAt {
            parts.append(SmmNumber.shortDay(SmmText.dayKey(of: publishedAt, in: timeZone)))
        }
        parts.append(top.format.title)
        if let views = top.views { parts.append("👁 \(SmmText.count(views))") }
        if let likes = top.likes { parts.append("♥ \(SmmText.count(likes))") }
        if let saves = top.saves, saves > 0 { parts.append("🔖 \(SmmText.count(saves))") }
        if top.postId != nil { parts.append("от маркетолога") }
        return parts.joined(separator: "  ")
    }
}

/// Words of the insight: weekday names and «when posts do best».
nonisolated enum SmmInsightText {
    private static let short = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"]
    /// «в понедельник», «во вторник»…
    private static let onDay = [
        "в воскресенье", "в понедельник", "во вторник", "в среду", "в четверг", "в пятницу", "в субботу",
    ]

    /// 0 — Sunday … 6 — Saturday.
    static func weekdayShort(_ weekday: Int) -> String {
        short[((weekday % 7) + 7) % 7]
    }

    /// «Лучше заходят посты в пятницу с 18:00 до 21:00 — по 24 публикациям за 60 дней.»
    static func bestTime(_ insight: SmmPlatformInsight) -> String? {
        let day = insight.weekdays.max { $0.avgViews < $1.avgViews }
        let hour = insight.hours.max { $0.avgViews < $1.avgViews }
        guard day != nil || hour != nil else { return nil }
        var text = "Лучше заходят посты"
        if let day { text += " " + onDay[((day.weekday % 7) + 7) % 7] }
        if let hour { text += " с \(hour.from):00 до \(hour.to):00" }
        let count = Plural.word(insight.posts, one: "публикации", few: "публикациям", many: "публикациям")
        return text + " — по \(insight.posts) \(count) за 60 дней."
    }
}
