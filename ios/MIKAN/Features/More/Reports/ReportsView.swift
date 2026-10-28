import SwiftUI

/// «Аналитика» (Ещё → Отчёты): the financial picture of the chosen period with deltas against the previous period
/// of the same length, shareable as a CSV table; «Рост» — the booking funnel, master load, retention and sources.
struct ReportsView: View {
    @Environment(APIClient.self) private var api
    @State private var period: ReportPeriod = .month
    /// The period on screen: cleared only for another one, not when the screen reappears after a swipe back.
    @State private var shownPeriodKey: String?
    @State private var customFrom = Calendar.app.date(byAdding: .day, value: -6, to: .now) ?? .now
    @State private var customTo = Date.now
    @State private var analytics = Remote<ReportAnalytics>()
    @State private var section = AnalyticsSection.finance
    @State private var growth = Remote<ReportGrowth>()

    private var interval: DateInterval {
        period.interval(customFrom: customFrom, customTo: customTo)
    }

    private var periodKey: String {
        "\(period.rawValue)-\(Int(interval.start.timeIntervalSince1970))-\(Int(interval.end.timeIntervalSince1970))"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // In the content, not a top bar: a horizontal scroll view gets no height of its own in a safe area bar.
                AnalyticsPeriodBar(period: $period)
                    .padding(.horizontal, -16)
                Picker("Раздел", selection: $section) {
                    ForEach(AnalyticsSection.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                header
                if section == .growth {
                    GrowthState(growth: growth, retry: load)
                } else if let value = analytics.value {
                    AnalyticsContent(analytics: value, comparison: ReportPeriod.rangeText(previousInterval(value)))
                } else if let failure = analytics.failure {
                    ErrorStateView(message: failure, retry: load)
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 240)
                }
            }
            .padding(16)
        }
        .background { AuraBackground() }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .refreshable { await load() }
        .task(id: periodKey) {
            if shownPeriodKey != periodKey {
                analytics.reset()
                growth.reset()
            }
            shownPeriodKey = periodKey
            await load()
        }
        .onChange(of: section) {
            Task { await loadIfNeeded() }
        }
        .remoteErrorAlert(analytics)
        .remoteErrorAlert(growth)
        .toolbar {
            if section == .finance, let value = analytics.value {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(
                        item: AnalyticsExport(value, interval: interval),
                        preview: SharePreview("Аналитика \(ReportPeriod.rangeText(interval))", image: Image(systemName: "tablecells"))
                    ) {
                        Label("Поделиться", systemImage: "square.and.arrow.up")
                    }
                }
            }
        }
        .navigationTitle("Аналитика")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private var header: some View {
        if period == .custom {
            VStack(spacing: 8) {
                DatePicker("С", selection: $customFrom, in: ...Date.now, displayedComponents: .date)
                DatePicker("По", selection: $customTo, in: ...Date.now, displayedComponents: .date)
                Text("Не больше \(Plural.days(ReportPeriod.maxDays)).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .cardStyle()
        }
        Text(ReportPeriod.rangeText(interval))
            .font(.title2.weight(.bold))
            .contentTransition(.opacity)
            .accessibilityAddTraits(.isHeader)
    }

    private func previousInterval(_ value: ReportAnalytics) -> DateInterval {
        DateInterval(start: value.previousFrom, end: max(value.previousFrom, value.previousTo))
    }

    private func load() async {
        let range = interval
        switch section {
        case .finance: await analytics.load { try await api.reportAnalytics(from: range.start, to: range.end) }
        case .growth: await growth.load { try await api.reportGrowth(from: range.start, to: range.end) }
        }
    }

    /// Switching to a part not loaded for this period yet loads it; one already loaded stays as it is.
    private func loadIfNeeded() async {
        let loaded = section == .finance ? analytics.value != nil : growth.value != nil
        if !loaded { await load() }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        ReportsView()
    }
    .previewEnvironment()
}
#endif
