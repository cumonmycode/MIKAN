import SwiftUI

/// Platform · format, status, topic and «when · direction · who posts».
struct SmmPostHeader: View {
    let post: SmmPost
    let direction: String?
    let timeZone: TimeZone

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    SmmPlatformBadge(post.platform)
                    Text("\(post.platform.title) · \(post.format.title)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    SmmStatusChip(post: post)
                }
                Text(post.topic)
                    .font(.title2.weight(.bold))
                    .textSelection(.enabled)
                Text(details)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        }
    }

    private var details: String {
        var parts = [SmmText.when(post.publishAt, in: timeZone)]
        if let direction { parts.append(direction) }
        if !post.autoPublishes, let name = post.assigneeName.nonEmpty { parts.append("выкладывает \(name)") }
        return parts.joined(separator: " · ")
    }
}

/// The text as it goes out: edit by hand or share (Instagram is posted by copying).
struct SmmPostBodySection: View {
    let post: SmmPost
    let onEdit: () -> Void

    var body: some View {
        let text = SmmText.plainText(post.body)
        if !text.isEmpty {
            Section {
                Text(text)
                    .font(.body)
                    .textSelection(.enabled)
                    .padding(.vertical, 2)
                HStack(spacing: 8) {
                    if post.status != .published {
                        Button("Изменить", systemImage: "pencil", action: onEdit)
                    }
                    ShareLink(item: text) {
                        Label("Поделиться текстом", systemImage: "square.and.arrow.up")
                    }
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
            } header: {
                HStack {
                    Text(title)
                    Spacer()
                    Text("\(text.count) зн.")
                        .monospacedDigit()
                }
            }
        }
    }

    private var title: String {
        if post.format == .story { return "Текст на сторис" }
        return post.platform == .instagram ? "Подпись" : "Текст поста"
    }
}

/// Script of a reel or the frames of a story series: the hook, numbered shots, sound, cast and a tip.
struct SmmPostScriptSection: View {
    let script: SmmScript
    let isStory: Bool

    var body: some View {
        Section(isStory ? "Кадры сторис" : "Сценарий рилс") {
            VStack(alignment: .leading, spacing: 2) {
                Text(hookCaption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(script.hook)
                    .font(.callout.weight(.semibold))
                    .textSelection(.enabled)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 14))
            .listRowSeparator(.hidden)
            ForEach(Array(script.shots.enumerated()), id: \.offset) { index, shot in
                shotRow(shot, number: index + 1)
            }
            if !notes.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(notes, id: \.self) { line in
                        Text(line)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }

    private var hookCaption: String {
        if isStory { return "ТЕМА ДНЯ" }
        guard let formula = script.formula.nonEmpty else { return "ЗАЦЕПКА" }
        return "ЗАЦЕПКА · \(formula.uppercased())"
    }

    private var notes: [String] {
        [
            script.audio.nonEmpty.map { "Звук: \($0)" },
            script.cast.nonEmpty.map { "Кто снимает: \($0)" },
            script.tips.nonEmpty.map { "Совет: \($0)" },
        ].compactMap(\.self)
    }

    private func shotRow(_ shot: SmmShot, number: Int) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)")
                .font(.caption.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Color.accentColor, in: .circle)
            VStack(alignment: .leading, spacing: 3) {
                Text(shot.text)
                    .font(.subheadline)
                    .textSelection(.enabled)
                if let overlay = shot.overlay.nonEmpty {
                    Text("На экране: «\(overlay)»")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let sticker = shot.sticker.nonEmpty {
                    Text("Стикер: \(sticker)")
                        .font(.footnote)
                        .foregroundStyle(Color.accentColor)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let seconds = shot.seconds, seconds > 0 {
                Text("\(Self.seconds(seconds)) с")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private static func seconds(_ value: Double) -> String {
        value.rounded() == value ? "\(Int(value))" : value.formatted(.number.precision(.fractionLength(1)).locale(.app))
    }
}

/// The idea behind the post — what to say and what to show; open for an idea, folded afterwards.
struct SmmPostIdeaSection: View {
    let post: SmmPost
    @State private var isExpanded: Bool

    init(post: SmmPost) {
        self.post = post
        _isExpanded = State(initialValue: post.status == .idea)
    }

    var body: some View {
        if !post.brief.trimmed.isEmpty || !post.visual.trimmed.isEmpty {
            Section {
                DisclosureGroup("Идея", isExpanded: $isExpanded) {
                    if !post.brief.trimmed.isEmpty {
                        Text(post.brief)
                            .font(.subheadline)
                            .textSelection(.enabled)
                    }
                    if !post.visual.trimmed.isEmpty {
                        Text("Визуал: \(post.visual)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .font(.headline)
            }
        }
    }
}

/// Forecast and result: expected views (from similar posts of the platform), the fact and all the numbers.
struct SmmPostResultSection: View {
    let post: SmmPost

    private static let statLabels: [(KeyPath<SmmPostStats, Int?>, String)] = [
        (\.views, "Просмотры"),
        (\.reach, "Охват"),
        (\.likes, "Лайки"),
        (\.reactions, "Реакции"),
        (\.comments, "Комменты"),
        (\.shares, "Репосты"),
        (\.saves, "Сохранения"),
    ]

    private var isPublished: Bool { post.status == .published }

    var body: some View {
        if isPublished || (post.forecast != nil && post.status != .skipped) {
            Section {
                if let forecast = post.forecast {
                    forecastRow(forecast)
                    SmmForecastScale(forecast: forecast, actual: isPublished ? post.stats.views : nil)
                        .padding(.vertical, 4)
                }
                if isPublished, !stats.isEmpty {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 84), alignment: .leading)], alignment: .leading, spacing: 12) {
                        ForEach(stats, id: \.label) { stat in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(SmmText.count(stat.value))
                                    .font(.title3.weight(.semibold))
                                    .monospacedDigit()
                                Text(stat.label)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                    .padding(.vertical, 4)
                }
            } header: {
                HStack {
                    Text(isPublished ? "Прогноз и результат" : "Прогноз")
                    Spacer()
                    if isPublished, let url = post.publishedUrl.flatMap(URL.init(string:)) {
                        Link("Открыть", destination: url)
                            .textCase(nil)
                    }
                }
            } footer: {
                Text(footnote)
            }
        }
    }

    private var stats: [(label: String, value: Int)] {
        Self.statLabels.compactMap { path, label in post.stats[keyPath: path].map { (label, $0) } }
    }

    private var place: String { post.platform == .telegram ? "канала" : "Instagram" }

    private var footnote: String {
        var parts: [String] = []
        if let forecast = post.forecast {
            let frozen = forecast.frozen == true ? ", зафиксирован в момент выхода" : ""
            parts.append("Прогноз — по \(forecast.basis) похожим постам \(place)\(frozen).")
        } else {
            parts.append("Прогноза пока нет — у \(place) мало истории.")
        }
        if isPublished {
            parts.append("Цифры маркетолог берёт по API: первые двое суток — каждый час, потом раз в день.")
        }
        return parts.joined(separator: " ")
    }

    private func forecastRow(_ forecast: SmmForecast) -> some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text("ПРОГНОЗ")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("~\(SmmText.count(forecast.expected))")
                    .font(.title2.weight(.bold))
                    .monospacedDigit()
                Text("просмотров · обычно \(SmmText.count(forecast.low))–\(SmmText.count(forecast.high))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if isPublished {
                factColumn(forecast)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func factColumn(_ forecast: SmmForecast) -> some View {
        let views = post.stats.views
        let color: Color = if let views {
            views > forecast.high ? .green : (views < forecast.low ? .orange : .primary)
        } else {
            .secondary
        }
        return VStack(alignment: .leading, spacing: 2) {
            Text("ФАКТ")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(views.map(SmmText.count) ?? "—")
                .font(.title2.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(color)
            Text(verdict(views: views, forecast: forecast))
                .font(.caption)
                .foregroundStyle(color)
        }
    }

    private func verdict(views: Int?, forecast: SmmForecast) -> String {
        guard let views, forecast.expected > 0 else { return "цифры придут в течение часа" }
        let diff = Int(((Double(views) / Double(forecast.expected) - 1) * 100).rounded())
        return diff >= 0 ? "на \(diff)% больше прогноза" : "на \(-diff)% меньше прогноза"
    }
}

/// The usual corridor of views, the expected mark and where the fact landed.
struct SmmForecastScale: View {
    let forecast: SmmForecast
    let actual: Int?

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let maximum = max(Double(forecast.high) * 1.35, Double(actual ?? 0) * 1.1, 1)
            let position = { (value: Int) in min(1, Double(value) / maximum) * width }
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color(.tertiarySystemFill))
                    .frame(width: max(width * 0.02, position(forecast.high) - position(forecast.low)), height: 8)
                    .offset(x: position(forecast.low))
                Rectangle()
                    .fill(Color.secondary)
                    .frame(width: 2, height: 14)
                    .offset(x: position(forecast.expected) - 1)
                if let actual {
                    Circle()
                        .fill(Color.accentColor)
                        .overlay(Circle().stroke(Color(.secondarySystemGroupedBackground), lineWidth: 2))
                        .frame(width: 12, height: 12)
                        .offset(x: position(actual) - 6)
                }
            }
            .frame(height: 14)
        }
        .frame(height: 14)
        .accessibilityElement()
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        let range = "Обычно от \(SmmText.count(forecast.low)) до \(SmmText.count(forecast.high))"
        guard let actual else { return range }
        return "\(range), факт \(SmmText.count(actual))"
    }
}
