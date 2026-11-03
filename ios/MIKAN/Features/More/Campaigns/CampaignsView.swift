import SwiftUI

/// More → «Рассылки» (owner, admin): Telegram campaigns, newest first.
struct CampaignsView: View {
    @Environment(APIClient.self) private var api
    @State private var campaigns = Remote<[Campaign]>()
    @State private var showsEditor = false
    @State private var opened: Campaign?

    var body: some View {
        List {
            ForEach(campaigns.value ?? []) { campaign in
                NavigationLink {
                    CampaignDetailView(campaignId: campaign.id, initial: campaign, onChange: apply)
                } label: {
                    CampaignRow(campaign: campaign)
                }
            }
        }
        .overlay {
            RemoteStateOverlay(remote: campaigns, retry: load) {
                ContentUnavailableView {
                    Label("Рассылок пока нет", systemImage: "megaphone")
                } description: {
                    Text("Напишите клиентам в Telegram об акции, новых украшениях или свободных окошках — бот отправит сообщение всем, кто подходит под условия.")
                } actions: {
                    Button("Новая рассылка") { showsEditor = true }
                        .buttonStyle(.glassProminent)
                }
            }
        }
        .navigationTitle("Рассылки")
        // A campaign just created opens at once: it is sent from its card.
        .navigationDestination(item: $opened) { campaign in
            CampaignDetailView(campaignId: campaign.id, initial: campaign, onChange: apply)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Новая рассылка", systemImage: "plus") { showsEditor = true }
            }
        }
        .sheet(isPresented: $showsEditor) {
            CampaignEditorView(campaign: nil) { created in
                campaigns.upsert(created)
                opened = created
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .remoteErrorAlert(campaigns)
    }

    private func apply(_ change: CampaignChange) {
        switch change {
        case .updated(let campaign): campaigns.upsert(campaign)
        case .deleted(let id): campaigns.remove(id: id)
        }
    }

    private func load() async {
        await campaigns.load { try await api.campaigns() }
    }
}

/// What the campaign card reports back to the list.
enum CampaignChange {
    case updated(Campaign)
    case deleted(Int)
}

struct CampaignRow: View {
    let campaign: Campaign

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(campaign.title.nonEmpty ?? "Без названия")
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                StatusBadge(text: campaign.status.title, color: campaign.status.color, systemImage: campaign.status.symbol)
            }
            Text(ChatMarkdown.plain(campaign.text))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            HStack(spacing: 6) {
                Text(CampaignPresentation.dateLine(campaign))
                if let progress = CampaignPresentation.progressLine(campaign.stats, status: campaign.status) {
                    Text("·")
                    Text(progress)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .monospacedDigit()
            if campaign.status == .sending {
                ProgressView(value: campaign.stats.progress)
                    .tint(campaign.status.color)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
extension PreviewData {
    static let campaign = Campaign(
        id: 1, title: "Осенняя акция", text: "{name}, **осенью** скидка 15% на пирсинг ушей 🍂",
        imageUrl: nil, button: .book,
        segment: CampaignSegment(lastVisitMonthsAgoMin: 3, categories: [.piercing]),
        status: .sending, scheduledAt: nil, startedAt: .now.addingTimeInterval(-120), finishedAt: nil,
        stats: CampaignStats(recipients: 124, sent: 80, failed: 2, blocked: 3, pending: 39),
        createdBy: EmployeeRef(id: 1, name: "Анна", color: "#FF7A1A"),
        createdAt: .now.addingTimeInterval(-3600), updatedAt: .now.addingTimeInterval(-120)
    )
}

#Preview {
    NavigationStack {
        CampaignsView()
    }
    .previewEnvironment()
}
#endif
