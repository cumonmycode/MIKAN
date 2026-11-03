import SwiftUI

/// Campaign card: title, state and when it happened.
struct CampaignHeaderSection: View {
    let campaign: Campaign

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                StatusBadge(text: campaign.status.title, color: campaign.status.color, systemImage: campaign.status.symbol)
                Text(campaign.title.nonEmpty ?? "Без названия")
                    .font(.title2.weight(.bold))
                Text(CampaignPresentation.dateLine(campaign))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let author = campaign.createdBy {
                    Label(author.name, systemImage: "person")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
        .listRowBackground(Color.clear)
    }
}

/// Campaign card: delivery counters, with a progress bar while sending.
struct CampaignStatsSection: View {
    let stats: CampaignStats
    let status: CampaignStatus

    var body: some View {
        Section {
            if status == .sending {
                VStack(alignment: .leading, spacing: 6) {
                    ProgressView(value: stats.progress)
                        .tint(status.color)
                    Text(stats.recipients > 0 ? "Отправлено \(stats.processed) из \(stats.recipients)" : "Готовим отправку…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                .padding(.horizontal, 4)
            }
            Grid(horizontalSpacing: 10, verticalSpacing: 10) {
                GridRow {
                    StatTile(title: "Получателей", value: "\(stats.recipients)", systemImage: "person.2")
                    StatTile(title: "Доставлено", value: "\(stats.sent)", systemImage: "checkmark.circle", tint: .green)
                }
                GridRow {
                    StatTile(title: "Не дошло", value: "\(stats.failed)", systemImage: "exclamationmark.triangle", tint: .orange)
                    StatTile(title: "Заблокировали", value: "\(stats.blocked)", systemImage: "hand.raised", tint: .red)
                }
            }
            if stats.pending > 0 {
                Label("В очереди: \(stats.pending)", systemImage: "hourglass")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .padding(.horizontal, 4)
            }
        } footer: {
            Text("«Заблокировали» — клиенты, которые остановили бота: им сообщения больше не приходят.")
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
    }
}

/// Campaign card: who the campaign is for, in words. Masters are named from `ReferenceStore` (the card loads it).
struct CampaignSegmentSummarySection: View {
    @Environment(ReferenceStore.self) private var reference
    let segment: CampaignSegment

    var body: some View {
        Section("Кому") {
            ForEach(CampaignSegmentText.lines(segment, masterName: masterName), id: \.self) { line in
                Text(line)
            }
        }
    }

    private func masterName(_ id: Int) -> String? {
        reference.employees.first { $0.id == id }?.name
    }
}
