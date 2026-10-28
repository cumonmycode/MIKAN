import Charts
import SwiftUI

/// Whether the plan is approved, the strategy and the goals of the month.
struct SmmPlanStrategyCard: View {
    let plan: SmmPlan

    private var isActive: Bool { plan.status == .active }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label {
                Text(isActive
                    ? "Утверждён — маркетолог готовит посты заранее"
                    : "Черновик — утвердите, и маркетолог начнёт готовить посты")
            } icon: {
                Image(systemName: isActive ? "checkmark.seal.fill" : "pencil.circle")
                    .foregroundStyle(isActive ? Color.green : Color.orange)
            }
            .font(.subheadline)
            VStack(alignment: .leading, spacing: 6) {
                Text("Стратегия")
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                Text(plan.summary)
                    .font(.body)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !plan.goals.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Цели")
                        .font(.headline)
                        .accessibilityAddTraits(.isHeader)
                    ForEach(Array(plan.goals.enumerated()), id: \.offset) { _, goal in
                        Label {
                            Text(goal).fixedSize(horizontal: false, vertical: true)
                        } icon: {
                            Image(systemName: "target").foregroundStyle(Color.accentColor)
                        }
                        .font(.subheadline)
                    }
                }
            }
        }
        .cardStyle()
    }
}

/// Rubrics of the month: a stacked bar of their shares and the legend with what each is about.
struct SmmPlanPillarsCard: View {
    let pillars: [SmmPillar]

    /// Minimal visible width of a tiny rubric on the bar, as in Titan.
    private static let minShare = 3.0
    private static let gap = 0.6

    private struct Segment: Identifiable {
        let index: Int
        let title: String
        let start: Double
        let end: Double

        var id: Int { index }
    }

    private var segments: [Segment] {
        var cursor = 0.0
        return pillars.enumerated().map { index, pillar in
            let width = max(pillar.share, Self.minShare)
            defer { cursor += width }
            return Segment(index: index, title: pillar.title, start: cursor, end: cursor + width - Self.gap)
        }
    }

    var body: some View {
        let segments = segments
        VStack(alignment: .leading, spacing: 12) {
            Text("Рубрики")
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            Chart(segments) { segment in
                BarMark(
                    xStart: .value("Начало", segment.start),
                    xEnd: .value("Конец", segment.end),
                    y: .value("Рубрики", "Рубрики")
                )
                .foregroundStyle(AnalyticsPalette.color(segment.index))
            }
            .chartXScale(domain: 0...max(segments.last?.end ?? 1, 1))
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartLegend(.hidden)
            .frame(height: 12)
            .clipShape(.capsule)
            .accessibilityHidden(true)
            ForEach(Array(pillars.enumerated()), id: \.element.id) { index, pillar in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Circle()
                        .fill(AnalyticsPalette.color(index))
                        .frame(width: 10, height: 10)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(pillar.title) · \(Int(pillar.share.rounded()))%")
                            .font(.subheadline.weight(.semibold))
                        if let about = pillar.about.nonEmpty {
                            Text(about)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .cardStyle()
    }
}

/// Holidays, memorable and own dates of the month: the marketer puts posts under them.
struct SmmPlanOccasionsCard: View {
    let dates: [SmmDate]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Поводы месяца")
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            ForEach(dates) { date in
                SmmOccasionLine(date: date, isDetailed: true)
            }
        }
        .cardStyle()
    }
}

/// «15 — День татуировщика», with the tone and the note when detailed.
struct SmmOccasionLine: View {
    let date: SmmDate
    var isDetailed = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle()
                .fill(date.tone.tint)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(SmmPlanMath.dayNumber(date.date) ?? 0) — \(date.title)")
                    .font(.subheadline)
                    .lineLimit(2)
                if isDetailed {
                    Text(date.note.nonEmpty.map { "\(date.tone.title): \($0)" } ?? date.tone.title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The month as a Monday-first grid: dots for publications in their platform colors, today ringed. A day with
/// publications shows them in the list below; an empty day ahead opens «Новая публикация» on that date.
struct SmmPlanCalendar: View {
    let month: String
    let posts: [SmmPost]
    let dates: [SmmDate]
    /// Today, `YYYY-MM-DD` in the studio time zone.
    let today: String
    let timeZone: TimeZone
    /// New publications may be added (not a past month).
    let canCreate: Bool
    let onShowDay: (SmmPlanDay) -> Void

    private static let weekdays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
    private static let maxDots = 3
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            LazyVGrid(columns: columns, spacing: 6) {
                ForEach(Self.weekdays, id: \.self) { weekday in
                    Text(weekday)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .accessibilityHidden(true)
                }
                ForEach(Array(SmmPlanMath.grid(posts, dates: dates, month: month, timeZone: timeZone).enumerated()), id: \.offset) { _, cell in
                    if let cell {
                        dayCell(cell)
                    } else {
                        Color.clear.frame(height: 44)
                    }
                }
            }
            if canCreate {
                Text("Нажмите на свободный день, чтобы добавить публикацию.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .cardStyle(padding: 12)
    }

    @ViewBuilder
    private func dayCell(_ day: SmmPlanDay) -> some View {
        let isPast = day.key < today
        if !day.posts.isEmpty {
            Button { onShowDay(day) } label: { cellLabel(day, isPast: isPast) }
                .buttonStyle(.plain)
                .accessibilityLabel("\(SmmText.dayTitle(day.key)), \(Plural.count(day.posts.count, one: "публикация", few: "публикации", many: "публикаций"))")
        } else if canCreate, !isPast {
            NavigationLink(value: SmmRoute.newPost(SmmPostDraft(date: day.key))) { cellLabel(day, isPast: false) }
                .buttonStyle(.plain)
                .accessibilityLabel("\(SmmText.dayTitle(day.key)), добавить публикацию")
        } else {
            cellLabel(day, isPast: isPast)
                .accessibilityLabel(SmmText.dayTitle(day.key))
        }
    }

    private func cellLabel(_ day: SmmPlanDay, isPast: Bool) -> some View {
        let isToday = day.key == today
        let occasion = day.dates.first
        return VStack(spacing: 4) {
            Text("\(day.day)")
                .font(.subheadline.weight(isToday ? .bold : .regular))
                .monospacedDigit()
                .foregroundStyle(isToday ? Color.accentColor : (isPast ? Color.secondary : Color.primary))
            HStack(spacing: 3) {
                ForEach(day.posts.prefix(Self.maxDots)) { post in
                    Circle()
                        .fill(post.status == .skipped ? Color.gray.opacity(0.5) : post.platform.tint)
                        .frame(width: 5, height: 5)
                }
            }
            .frame(height: 5)
        }
        .frame(maxWidth: .infinity, minHeight: 44)
        .background {
            RoundedRectangle(cornerRadius: 10)
                .fill(occasion.map { $0.tone.tint.opacity(0.14) } ?? Color.clear)
        }
        .overlay {
            if isToday {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(Color.accentColor, lineWidth: 1.5)
            }
        }
        .contentShape(.rect(cornerRadius: 10))
    }
}

/// A plan error left by the marketer.
struct SmmFailureBanner: View {
    let text: String

    var body: some View {
        Label {
            Text(text).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .font(.subheadline)
        .foregroundStyle(.red)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.12), in: .rect(cornerRadius: 14))
    }
}

/// Title of a group of cards, with an optional action on the right.
struct SmmGroupTitle<Trailing: View>: View {
    let title: String
    @ViewBuilder let trailing: () -> Trailing

    init(_ title: String, @ViewBuilder trailing: @escaping () -> Trailing) {
        self.title = title
        self.trailing = trailing
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.title3.weight(.bold))
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            trailing()
                .font(.subheadline.weight(.semibold))
        }
        .padding(.top, 8)
    }
}

extension SmmGroupTitle where Trailing == EmptyView {
    init(_ title: String) {
        self.init(title) { EmptyView() }
    }
}
