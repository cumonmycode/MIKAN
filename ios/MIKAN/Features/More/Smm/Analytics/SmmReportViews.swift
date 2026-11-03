import SwiftUI

nonisolated extension SmmReport {
    /// «03.11–09.11».
    var periodText: String {
        "\(SmmNumber.shortDay(periodFrom))–\(SmmNumber.shortDay(periodTo))"
    }
}

/// A report in the analytics list: the period, the title and the start of the summary.
struct SmmReportRow: View {
    let report: SmmReport

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(report.periodText)
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                Text(report.title)
                    .font(.headline)
                    .multilineTextAlignment(.leading)
                if let summary = report.summary.nonEmpty {
                    Text(summary)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .cardStyle(padding: 14)
        .contentShape(.rect(cornerRadius: Theme.cardRadius))
        .accessibilityElement(children: .combine)
    }
}

/// «Отчёт» (Titan `ReportCard`, opened): the marketer's summary of the period, the numbers with their changes and
/// what to do next.
struct SmmReportView: View {
    @Environment(APIClient.self) private var api
    @Environment(SmmProfileStore.self) private var store

    let id: String
    @State private var report: Remote<SmmReport>

    init(id: String, initial: SmmReport? = nil) {
        self.id = id
        _report = State(initialValue: Remote(initial))
    }

    var body: some View {
        ScrollView {
            if let value = report.value {
                content(value)
                    .padding(16)
            }
        }
        .background { AuraBackground() }
        .overlay {
            if report.value == nil {
                RemoteStateOverlay(remote: report, retry: load)
            }
        }
        .refreshable { await load() }
        .task {
            if report.value == nil { await load() }
        }
        .remoteErrorAlert(report)
        .navigationTitle("Отчёт")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func content(_ report: SmmReport) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(report.periodText)
                    .font(.subheadline)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                Text(report.title)
                    .font(.title2.weight(.bold))
                    .accessibilityAddTraits(.isHeader)
            }
            if let summary = report.summary.nonEmpty {
                Text(summary)
                    .font(.body)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .cardStyle()
            }
            if !report.metrics.isEmpty {
                metrics(report.metrics)
            }
            if !report.recommendations.isEmpty {
                recommendations(report.recommendations)
            }
            Text("Маркетолог сохраняет выводы отчётов в память и учитывает их в следующих планах и постах.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private func metrics(_ metrics: [SmmReportMetric]) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 12)], spacing: 12) {
            ForEach(metrics) { metric in
                VStack(alignment: .leading, spacing: 4) {
                    Text(metric.label)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(metric.value)
                        .font(.title3.weight(.bold))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    if let delta = metric.delta {
                        Text(SmmNumber.signedPercent(delta))
                            .font(.caption.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(delta >= 0 ? Color.green : Color.red)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .cardStyle(padding: 14)
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func recommendations(_ items: [SmmRecommendation]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Что делать дальше")
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            ForEach(items) { item in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: "arrow.right.circle.fill")
                        .foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(.subheadline.weight(.semibold))
                        Text(item.detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .cardStyle()
    }

    private func load() async {
        let profile = store.profile
        let id = id
        await report.load { try await api.smmReport(profile, id: id) }
    }
}

/// A period for «Сделать отчёт»: from and to, both days included (the device calendar).
struct SmmReportPeriodSheet: View {
    @Environment(\.dismiss) private var dismiss

    /// `from` / `to` — `YYYY-MM-DD`.
    let onGenerate: (String, String) -> Void

    @State private var from = Calendar.app.date(byAdding: .day, value: -7, to: .now) ?? .now
    @State private var to = Calendar.app.date(byAdding: .day, value: -1, to: .now) ?? .now

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("С", selection: $from, in: ...Date.now, displayedComponents: .date)
                    DatePicker("По", selection: $to, in: from...Date.now, displayedComponents: .date)
                } footer: {
                    Text("Маркетолог разберёт цифры площадок и публикации за эти дни, сравнит с прошлым и напишет, что делать дальше.")
                }
            }
            .onChange(of: from) { _, newValue in
                if to < newValue { to = newValue }
            }
            .navigationTitle("Период отчёта")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Сделать") {
                        let start = SmmText.dayKey(of: min(from, to), in: .current)
                        let end = SmmText.dayKey(of: max(from, to), in: .current)
                        dismiss()
                        onGenerate(start, end)
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }
}
