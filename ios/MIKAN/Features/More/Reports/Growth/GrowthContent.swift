import SwiftUI

/// The two parts of the analytics screen: money («Финансы») and how the studio grows («Рост»).
nonisolated enum AnalyticsSection: String, CaseIterable, Identifiable, Sendable {
    case finance
    case growth

    var id: String { rawValue }

    var title: String {
        switch self {
        case .finance: "Финансы"
        case .growth: "Рост"
        }
    }
}

/// «Рост» for one loaded period: the booking funnel, master load, retention, client value and sources.
struct GrowthContent: View {
    let growth: ReportGrowth

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if growth.isEmpty {
                ContentUnavailableView(
                    "За этот период пусто",
                    systemImage: "chart.line.uptrend.xyaxis",
                    description: Text("Здесь появятся записи, заявки, визиты и новые клиенты.")
                )
            } else {
                GrowthFunnelCard(funnel: growth.funnel)
                GrowthLoadCard(load: growth.load)
                GrowthRetentionCard(retention: growth.retention)
                GrowthValueCard(value: growth.value)
                GrowthSourcesCard(sources: growth.sources)
            }
        }
    }
}

/// «Рост» while it loads, failed or is ready.
struct GrowthState: View {
    let growth: Remote<ReportGrowth>
    let retry: () async -> Void

    var body: some View {
        if let value = growth.value {
            GrowthContent(growth: value)
        } else if let failure = growth.failure {
            ErrorStateView(message: failure, retry: retry)
        } else {
            ProgressView().frame(maxWidth: .infinity, minHeight: 240)
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        ScrollView {
            GrowthContent(growth: PreviewData.growth)
                .padding()
        }
        .background { AuraBackground() }
    }
    .previewEnvironment()
}
#endif
