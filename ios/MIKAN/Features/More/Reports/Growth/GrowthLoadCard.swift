import Charts
import SwiftUI

/// «Загрузка мастеров»: the share of each master's working time (their schedule, studio hours without one) taken by
/// appointments; a tap opens the split by weekday.
struct GrowthLoadCard: View {
    let load: [GrowthMasterLoad]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            AnalyticsCardTitle(
                title: "Загрузка мастеров",
                systemImage: "gauge.with.dots.needle.50percent",
                caption: "Какая часть рабочего времени по графику занята записями"
            )
            if load.isEmpty {
                Text("Нет активных мастеров").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(load) { master in
                NavigationLink {
                    GrowthMasterLoadView(load: master)
                } label: {
                    row(master).contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
            if load.contains(where: { ($0.loadPercent ?? 0) > 100 }) {
                AnalyticsHint(text: "Больше 100 % — записи сверх графика.", systemImage: "exclamationmark.circle")
            }
            AnalyticsHint(text: "Без своего графика мастер работает по часам студии. Отмены и неявки не считаются.")
        }
        .cardStyle()
    }

    private func row(_ master: GrowthMasterLoad) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Circle().fill(Color.master(master.employee.color)).frame(width: 10, height: 10)
                Text(master.employee.name).font(.subheadline.weight(.medium))
                Spacer(minLength: 8)
                Text(GrowthText.wholePercent(master.loadPercent))
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            ProgressView(value: GrowthText.loadFraction(master))
                .tint(Color.master(master.employee.color))
            Text(GrowthText.loadDetail(master))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Открыть загрузку по дням недели")
    }
}

/// A master's load by weekday: working time against booked time, studio time.
struct GrowthMasterLoadView: View {
    let load: GrowthMasterLoad

    private var days: [GrowthWeekdayLoad] { GrowthText.weekdays(load) }
    private var tint: Color { Color.master(load.employee.color) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                summary
                chart
                list
            }
            .padding(16)
        }
        .background { AuraBackground() }
        .navigationTitle(load.employee.name)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(GrowthText.wholePercent(load.loadPercent))
                .font(.largeTitle.weight(.bold))
                .monospacedDigit()
            Text(GrowthText.loadDetail(load))
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .cardStyle()
        .accessibilityElement(children: .combine)
    }

    private var chart: some View {
        VStack(alignment: .leading, spacing: 12) {
            AnalyticsCardTitle(title: "По дням недели", systemImage: "calendar", caption: "Светлое — рабочее время, яркое — занятое записями")
            Chart(days) { day in
                BarMark(x: .value("День", ReportText.weekday(day.weekday)), y: .value("Часы", Double(day.workingMinutes) / 60), stacking: .unstacked)
                    .foregroundStyle(tint.opacity(0.25))
                    .cornerRadius(4)
                BarMark(
                    x: .value("День", ReportText.weekday(day.weekday)), y: .value("Часы", Double(day.bookedMinutes) / 60),
                    width: .ratio(0.5), stacking: .unstacked
                )
                    .foregroundStyle(tint.gradient)
                    .cornerRadius(4)
            }
            .chartYAxisLabel("часы")
            .frame(height: 200)
            .accessibilityLabel("Рабочее и занятое время по дням недели")
        }
        .cardStyle()
    }

    private var list: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(days) { day in
                AnalyticsValueRow(
                    title: ReportText.weekday(day.weekday, full: true),
                    value: GrowthText.weekdayPercent(day),
                    detail: day.workingMinutes > 0 || day.bookedMinutes > 0
                        ? "Занято \(GrowthText.duration(minutes: day.bookedMinutes)) из \(GrowthText.duration(minutes: day.workingMinutes))"
                        : "Выходной"
                )
            }
            AnalyticsHint(text: "Записи, переходящие через полночь, делятся между днями.")
        }
        .cardStyle()
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        ScrollView {
            GrowthLoadCard(load: PreviewData.growth.load)
                .padding()
        }
        .background { AuraBackground() }
    }
    .previewEnvironment()
}
#endif
