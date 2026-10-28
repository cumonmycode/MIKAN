import SwiftUI

/// «Поставки»: recorded deliveries, newest first, loaded page by page. Owner and admin receive a new one here;
/// a master only looks.
struct DeliveriesListView: View {
    @Environment(APIClient.self) private var api
    @Environment(\.permissions) private var permissions
    /// A delivery was recorded here: the warehouse reloads its stock.
    var onDelivered: (StockDelivery) -> Void = { _ in }

    @State private var deliveries = Remote<[StockDelivery]>()
    @State private var total = 0
    @State private var isLoadingMore = false
    @State private var showsEditor = false

    private static let pageSize = 50

    var body: some View {
        List {
            ForEach(deliveries.value ?? []) { delivery in
                NavigationLink {
                    DeliveryDetailView(delivery: delivery)
                } label: {
                    DeliveryRow(delivery: delivery)
                }
                .task { await loadMore(after: delivery) }
            }
            if isLoadingMore {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .auraBackground()
        .overlay {
            RemoteStateOverlay(remote: deliveries, retry: load) {
                ContentUnavailableView {
                    Label("Поставок пока не было", systemImage: "shippingbox")
                } description: {
                    Text("Принимайте товар от поставщика одной поставкой: несколько позиций и размеров сразу, с ценой закупки.")
                } actions: {
                    if permissions.editsCatalog {
                        Button("Принять поставку") { showsEditor = true }
                            .buttonStyle(.glassProminent)
                    }
                }
            }
        }
        .refreshable { await load() }
        .task {
            // Coming back from a pushed delivery keeps the loaded pages.
            guard deliveries.value == nil else { return }
            await load()
        }
        .remoteErrorAlert(deliveries)
        .navigationTitle("Поставки")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if permissions.editsCatalog {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Принять поставку", systemImage: "plus") { showsEditor = true }
                }
            }
        }
        .sheet(isPresented: $showsEditor) {
            DeliveryEditorView { delivery in
                deliveries.upsert(delivery)
                total += 1
                onDelivered(delivery)
            }
        }
    }

    private func load() async {
        await deliveries.load {
            let page = try await api.deliveries(limit: Self.pageSize)
            total = page.total ?? page.items.count
            return page.items
        }
    }

    private func loadMore(after delivery: StockDelivery) async {
        guard let items = deliveries.value, delivery.id == items.last?.id, items.count < total, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await api.deliveries(limit: Self.pageSize, offset: items.count)
            let known = Set(items.map(\.id))
            deliveries.update { $0 + page.items.filter { !known.contains($0.id) } }
            total = page.items.isEmpty ? items.count : (page.total ?? total)
        } catch is CancellationError {
            return
        } catch {
            deliveries.transientError = error.userMessage
        }
    }
}

/// «Поставка №4», when, from whom and who received it, how much.
struct DeliveryRow: View {
    let delivery: StockDelivery

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "shippingbox.fill")
                .foregroundStyle(.green)
                .frame(width: 28, height: 28)
                .background(Color.green.opacity(0.14), in: .circle)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(DeliveryText.title(number: delivery.number))
                    .font(.subheadline.weight(.semibold))
                Text(DeliveryText.subtitle(delivery))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(DeliveryText.summary(positions: delivery.lineCount, units: delivery.itemCount, unit: nil))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                if let note = delivery.note.nonEmpty {
                    Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            if delivery.total > 0 {
                MoneyText(delivery.total)
                    .font(.subheadline.weight(.semibold))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        DeliveriesListView()
    }
    .previewEnvironment()
}
#endif
