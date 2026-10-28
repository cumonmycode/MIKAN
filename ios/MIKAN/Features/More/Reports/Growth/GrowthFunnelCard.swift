import SwiftUI

/// «Воронка записи»: online bookings and bot requests from the first step to the visit, and every appointment booked
/// in the period by channel.
struct GrowthFunnelCard: View {
    let funnel: GrowthFunnel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            AnalyticsCardTitle(
                title: "Воронка записи",
                systemImage: "line.3.horizontal.decrease",
                caption: "Записи и заявки, созданные за период, и чем они закончились"
            )
            if funnel.online.created > 0 {
                block(
                    steps: GrowthText.onlineSteps(funnel.online),
                    color: AnalyticsPalette.color(0),
                    losses: GrowthText.onlineLosses(funnel.online),
                    channels: GrowthText.channelLine(funnel.online.byChannel)
                )
                AnalyticsHint(text: "Онлайн — бот, Mini App и сайт. «Пришли» — визит завершён; проценты — от всех онлайн-записей.")
                Divider()
            }
            if funnel.bookingRequests.created > 0 {
                block(
                    steps: GrowthText.requestSteps(funnel.bookingRequests),
                    color: AnalyticsPalette.color(3),
                    losses: GrowthText.requestLosses(funnel.bookingRequests)
                )
                Divider()
            }
            block(
                steps: GrowthText.appointmentSteps(funnel.appointments),
                color: AnalyticsPalette.color(1),
                channels: GrowthText.channelLine(funnel.appointments.byChannel)
            )
            AnalyticsHint(text: "Все записи — из приложения и онлайн, по дате создания; проценты — от созданных.")
        }
        .cardStyle()
    }

    private func block(steps: [GrowthText.Step], color: Color, losses: String? = nil, channels: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                GrowthFunnelBar(step: step, color: color, isFirst: index == 0)
            }
            if let losses {
                Text(losses).font(.caption).foregroundStyle(.secondary)
            }
            if let channels {
                Label(channels, systemImage: "arrow.triangle.branch")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// One step of a funnel: title, count, share of the first step and a bar.
struct GrowthFunnelBar: View {
    let step: GrowthText.Step
    var color: Color = .accentColor
    var isFirst = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(step.title).fontWeight(isFirst ? .semibold : .regular)
                Spacer(minLength: 8)
                Text("\(step.count)").fontWeight(.semibold).monospacedDigit()
                if !isFirst {
                    Text(step.percent)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .frame(minWidth: 44, alignment: .trailing)
                }
            }
            .font(.subheadline)
            ProgressView(value: step.fraction)
                .tint(color.opacity(isFirst ? 0.5 : 1))
        }
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
#Preview {
    ScrollView {
        GrowthFunnelCard(funnel: PreviewData.growth.funnel)
            .padding()
    }
    .background { AuraBackground() }
}
#endif
