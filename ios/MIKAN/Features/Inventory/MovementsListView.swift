import SwiftUI

/// All stock movements, newest first, with a type filter and pagination.
struct MovementsListView: View {
    @Environment(APIClient.self) private var api
    @State private var type: MovementType?
    /// The filter on screen (`"all"` — no filter): cleared only for another one, not when the screen reappears.
    @State private var shownTypeKey: String?
    @State private var movements = Remote<[StockMovement]>()
    @State private var total = 0
    @State private var isLoadingMore = false

    private static let pageSize = 50

    var body: some View {
        List {
            ForEach(movements.value ?? []) { movement in
                MovementLink(movement: movement, showsProduct: true)
                    .task { await loadMore(after: movement) }
            }
            if isLoadingMore {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .overlay {
            RemoteStateOverlay(remote: movements, retry: load) {
                ContentUnavailableView(
                    "Движений нет",
                    systemImage: "arrow.left.arrow.right",
                    description: Text(type == nil ? "Здесь появятся приходы, продажи, списания и покупки." : "Нет движений этого типа.")
                )
            }
        }
        .refreshable { await load() }
        .task(id: type) {
            let key = type?.rawValue ?? "all"
            if shownTypeKey != key { movements.reset() }
            shownTypeKey = key
            await load()
        }
        .remoteErrorAlert(movements)
        .navigationTitle("Движения")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Тип", selection: $type) {
                        Text("Все").tag(MovementType?.none)
                        ForEach(MovementType.listed) { type in
                            Label(type.title, systemImage: type.symbol).tag(MovementType?.some(type))
                        }
                    }
                } label: {
                    Label("Фильтр", systemImage: type == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                }
            }
        }
    }

    private func load() async {
        let type = type
        await movements.load {
            let page = try await api.stockMovements(type: type, limit: Self.pageSize)
            total = page.total ?? page.items.count
            return page.items
        }
    }

    private func loadMore(after movement: StockMovement) async {
        guard let items = movements.value, movement.id == items.last?.id, items.count < total, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await api.stockMovements(type: type, limit: Self.pageSize, offset: items.count)
            let known = Set(items.map(\.id))
            movements.update { $0 + page.items.filter { !known.contains($0.id) } }
        } catch is CancellationError {
            return
        } catch {
            movements.transientError = error.userMessage
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        MovementsListView()
    }
    .previewEnvironment()
}
#endif
