import SwiftUI

nonisolated extension SmmProgress {
    /// Where the bar is now: from `pct` toward `next` — fast at the start of the stage and slower toward the end
    /// (about 95% of the way by `eta`, then nearly still until the server names the next stage). Never 100.
    func percent(at now: Date) -> Double {
        let elapsed = max(0, now.timeIntervalSince(at))
        let share = 1 - exp(-3 * elapsed / max(eta, 1))
        return min(99, pct + (next - pct) * share)
    }

    /// Roughly how many seconds of the stage are left.
    func secondsLeft(at now: Date) -> Int {
        max(0, Int((eta - now.timeIntervalSince(at)).rounded()))
    }

    /// «Осталось около 2 мин» / «Почти готово…».
    func leftText(at now: Date) -> String {
        let left = secondsLeft(at: now)
        guard left > 3 else { return "Почти готово…" }
        let amount = left >= 90 ? "\(Int((Double(left) / 60).rounded())) мин" : "\(left) с"
        return "Осталось около \(amount)"
    }
}

/// Readiness bar: the fill catches up with `value` (0–100) smoothly, with a sheen running over the filled part.
struct SmmProgressBar: View {
    let value: Double
    var thin = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var fraction: Double { min(max(value, 2), 100) / 100 }

    var body: some View {
        Capsule()
            .fill(Color(.tertiarySystemFill))
            .overlay(alignment: .leading) {
                GeometryReader { proxy in
                    Capsule()
                        .fill(Color.accentColor)
                        .overlay {
                            if !reduceMotion { SmmSheen() }
                        }
                        .clipShape(.capsule)
                        .frame(width: proxy.size.width * fraction)
                }
            }
            .frame(height: thin ? 3 : 6)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.45), value: fraction)
            .accessibilityElement()
            .accessibilityLabel("Готовность")
            .accessibilityValue("\(Int(value.rounded())) %")
    }
}

/// The bar of a server stage: eases from `pct` to `next` over `eta` seconds since `at`, between polls too.
struct SmmLiveProgressBar: View {
    let progress: SmmProgress
    var thin = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: thin ? 0.5 : 0.25)) { context in
            SmmProgressBar(value: progress.percent(at: context.date), thin: thin)
        }
    }
}

/// What the marketer is doing, the percent and roughly how long is left. Without a scale (an older task) —
/// a spinner with `text`; with neither — nothing.
struct SmmProgressBanner: View {
    let progress: SmmProgress?
    var text: String?

    init(progress: SmmProgress?, text: String? = nil) {
        self.progress = progress
        self.text = text
    }

    var body: some View {
        if let progress {
            TimelineView(.periodic(from: .now, by: 0.25)) { context in
                scale(progress, now: context.date)
            }
            .transition(.opacity)
        } else if let text {
            HStack(spacing: 12) {
                ProgressView()
                Text(text)
                    .font(.subheadline)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(12)
            .background(Color.accentColor.opacity(0.1), in: .rect(cornerRadius: 14))
            .accessibilityElement(children: .combine)
        }
    }

    private func scale(_ progress: SmmProgress, now: Date) -> some View {
        let percent = progress.percent(at: now)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .foregroundStyle(Color.accentColor)
                    .symbolEffect(.pulse)
                Text(progress.label)
                    .font(.subheadline)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("\(Int(percent.rounded()))%")
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(Color.accentColor)
            }
            SmmProgressBar(value: percent)
            Text(progress.leftText(at: now))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(Color.accentColor.opacity(0.08), in: .rect(cornerRadius: 14))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(progress.label), \(Int(percent.rounded())) процентов")
    }
}

/// A soft highlight sliding across the filled part of the bar.
private struct SmmSheen: View {
    @State private var phase: CGFloat = -1

    var body: some View {
        GeometryReader { proxy in
            LinearGradient(colors: [.clear, .white.opacity(0.35), .clear], startPoint: .leading, endPoint: .trailing)
                .frame(width: max(proxy.size.width * 0.6, 24))
                .offset(x: phase * max(proxy.size.width, 24))
        }
        .allowsHitTesting(false)
        .onAppear {
            withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) {
                phase = 1.4
            }
        }
    }
}
