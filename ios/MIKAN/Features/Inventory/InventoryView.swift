import SwiftUI

/// Screens pushed from the warehouse toolbar.
enum WarehouseRoute: Hashable {
    case movements
    case revisions
    case deliveries
}

/// «Склад» — the unified warehouse: Украшения · Услуги · Расходники · Товары. Product sections list their products by
/// category in the staff order; «Услуги» shows the services catalog.
struct InventoryView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppState.self) private var appState
    @Environment(ReferenceStore.self) private var reference
    @Environment(\.permissions) private var permissions
    @State private var model = InventoryModel()
    @State private var showsEditor = false
    @State private var showsCategories = false
    @State private var showsRevision = false
    @State private var showsDelivery = false
    @State private var categoriesChanged = false
    @State private var route: WarehouseRoute?
    @State private var errorMessage: String?
    /// Recreates the services catalog after its categories changed, so it reloads with the new names.
    @State private var servicesGeneration = 0

    var body: some View {
        NavigationStack {
            content
                .safeAreaBar(edge: .top) {
                    InventoryFilterBar(model: model, categoryOptions: categoryOptions) { section in
                        model.select(section)
                    }
                }
                .navigationTitle("Склад")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar }
                .navigationDestination(item: $route) { route in
                    switch route {
                    case .movements: MovementsListView()
                    case .revisions: RevisionHistoryView()
                    case .deliveries: DeliveriesListView { _ in stockChanged() }
                    }
                }
                .sheet(isPresented: $showsEditor) {
                    ProductEditorView(product: nil, defaultKind: model.kind ?? .jewelry, categories: model.knownCategories) { saved in
                        model.upsert(saved)
                        Task { await appState.refreshBadges() }
                    }
                }
                .sheet(isPresented: $showsCategories, onDismiss: categoriesClosed) {
                    CategoriesEditorView(section: model.section) { categoriesChanged = true }
                }
                .sheet(isPresented: $showsRevision) {
                    RevisionFlowView(initialSection: model.kind.map(CatalogSection.init(kind:))) { _ in
                        stockChanged()
                    }
                }
                .sheet(isPresented: $showsDelivery) {
                    DeliveryEditorView { _ in stockChanged() }
                }
                // Only orders the groups; without the registry they fall back to alphabetical order.
                .task { try? await reference.ensureCategories() }
                .errorAlert($errorMessage)
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.section == .service {
            ServicesListView()
                .id(servicesGeneration)
        } else {
            productList
        }
    }

    private var categoryOptions: [String] { model.categoryOptions(categories: reference.categories) }

    // MARK: - Products

    private var productList: some View {
        @Bindable var bindable = model
        return List {
            ForEach(model.groups(categories: reference.categories)) { group in
                Section {
                    ForEach(group.items) { product in
                        productLink(product)
                    }
                } header: {
                    WarehouseGroupHeader(title: group.title, products: group.items)
                }
            }
        }
        .auraBackground()
        .scrollEdgeEffectStyle(.soft, for: .top)
        // Keep the top chrome a fixed height: a collapsing large title plus an auto-hiding search
        // drawer above the pinned filter bar fed back into the list's insets and made it shake at the top.
        .searchable(
            text: $bindable.filter.search,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: searchPrompt
        )
        .overlay {
            RemoteStateOverlay(
                remote: model.remote,
                isEmpty: { model.filter.apply($0).isEmpty },
                retry: { await model.load(api: api) }
            ) {
                emptyState
            }
        }
        .refreshable {
            async let products: Void = model.load(api: api)
            async let categories: Void = refreshCategories()
            _ = await (products, categories)
            await appState.refreshBadges()
        }
        .task(id: model.section) { await model.load(api: api) }
        .onReconnect { await model.load(api: api) }
        .remoteErrorAlert(model.remote)
    }

    private func productLink(_ product: Product) -> some View {
        NavigationLink {
            ProductDetailView(
                product: product,
                categories: model.knownCategories,
                onDelete: { id in
                    model.remove(productId: id)
                    Task { await appState.refreshBadges() }
                }
            ) { updated in
                model.upsert(updated)
                Task { await appState.refreshBadges() }
            }
        } label: {
            ProductRow(product: product, highlightedSize: model.filter.size)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if product.isPresenceTracked, permissions.editsCatalog {
                ForEach(PresenceStatus.allCases.reversed().filter { $0 != product.presenceStatus }) { status in
                    Button(status.shortTitle, systemImage: status.symbol) { setPresence(status, of: product) }
                        .tint(status.color)
                }
            }
        }
    }

    private var searchPrompt: String {
        switch model.kind {
        case .consumable: "Название, артикул, поставщик"
        case .goods: "Название, артикул, размер, поставщик"
        default: "Название, артикул, размер, материал"
        }
    }

    private func setPresence(_ status: PresenceStatus, of product: Product) {
        Task {
            if let message = await model.setPresence(status, of: product, api: api) {
                errorMessage = message
            }
            await appState.refreshBadges()
        }
    }

    private func refreshCategories() async {
        try? await reference.ensureCategories(force: true)
    }

    /// A stock count or a delivery changed many stocks at once: reload the lists and the low-stock badge.
    private func stockChanged() {
        Task {
            await model.reloadLoaded(api: api)
            await appState.refreshBadges()
        }
    }

    /// Renames, merges and deletions moved items between categories: reload what is on screen.
    private func categoriesClosed() {
        guard categoriesChanged else { return }
        categoriesChanged = false
        Task {
            if model.section == .service {
                try? await reference.ensureServices(force: true)
                servicesGeneration += 1
            } else {
                await model.reloadLoaded(api: api)
            }
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if !permissions.editsCatalog {
            // A master looks at the stock: its history only.
            if model.section != .service {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Поставки", systemImage: "shippingbox") { route = .deliveries }
                        Button("История ревизий", systemImage: "clock.arrow.circlepath") { route = .revisions }
                        Button("Движения", systemImage: "arrow.left.arrow.right") { route = .movements }
                    } label: {
                        Label("Склад", systemImage: "ellipsis")
                    }
                }
            }
        } else if model.section == .service {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Категории услуг", systemImage: "folder") { showsCategories = true }
            }
        } else {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Категории \(model.section.genitiveTitle)", systemImage: "folder") { showsCategories = true }
                    Divider()
                    Button("Принять поставку", systemImage: "shippingbox.and.arrow.backward") { showsDelivery = true }
                    Button("Поставки", systemImage: "shippingbox") { route = .deliveries }
                    Divider()
                    Button("Провести ревизию", systemImage: "checklist") { showsRevision = true }
                    Button("История ревизий", systemImage: "clock.arrow.circlepath") { route = .revisions }
                    Button("Движения", systemImage: "arrow.left.arrow.right") { route = .movements }
                } label: {
                    Label("Склад", systemImage: "ellipsis")
                }
            }
            ToolbarSpacer(.fixed, placement: .topBarTrailing)
            ToolbarItem(placement: .topBarTrailing) {
                Button(addTitle, systemImage: "plus") { showsEditor = true }
            }
        }
    }

    private var addTitle: String {
        switch model.kind {
        case .goods: "Добавить товар"
        case .consumable: "Добавить расходник"
        default: "Добавить украшение"
        }
    }

    // MARK: - Empty states

    @ViewBuilder
    private var emptyState: some View {
        let filter = model.filter
        if !filter.search.trimmed.isEmpty {
            ContentUnavailableView.search(text: filter.search)
        } else if filter.facetCount > 0 {
            ContentUnavailableView {
                Label("Ничего не найдено", systemImage: "line.3.horizontal.decrease.circle")
            } description: {
                Text("Нет позиций с такими параметрами.")
            } actions: {
                Button("Сбросить фильтры") {
                    withAnimation(.snappy) { model.filter = filter.cleared }
                }
                .buttonStyle(.glass)
            }
        } else if filter.lowOnly {
            ContentUnavailableView(
                "Всего достаточно",
                systemImage: "checkmark.seal",
                description: Text("Нет позиций, которые заканчиваются.")
            )
        } else {
            ContentUnavailableView {
                Label(emptyTitle, systemImage: model.section.symbol)
            } description: {
                Text(emptyDescription)
            } actions: {
                if permissions.editsCatalog {
                    Button(addTitle) { showsEditor = true }
                        .buttonStyle(.glassProminent)
                }
            }
        }
    }

    private var emptyTitle: String {
        switch model.kind {
        case .goods: "Товаров пока нет"
        case .consumable: "Расходников пока нет"
        default: "Украшений пока нет"
        }
    }

    private var emptyDescription: String {
        switch model.kind {
        case .goods: "Спреи для ухода, сертификаты и всё, что продаётся в кассе помимо украшений."
        case .consumable: "Иглы, перчатки, антисептики — то, что уходит на процедуры. Одни считаются поштучно, другие — «есть / нет»."
        default: "Добавьте украшение с размерами и начальным остатком — оно появится в кассе и у бота."
        }
    }
}

/// Category title with the number of positions and how many of them run low.
private struct WarehouseGroupHeader: View {
    let title: String
    let products: [Product]

    var body: some View {
        let low = products.filter(\.lowStock).count
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title)
            Spacer()
            if low > 0 {
                Text("мало: \(low)")
                    .foregroundStyle(.orange)
            }
            Text("\(products.count)")
                .monospacedDigit()
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

#if DEBUG
#Preview {
    InventoryView()
        .previewEnvironment()
}
#endif
