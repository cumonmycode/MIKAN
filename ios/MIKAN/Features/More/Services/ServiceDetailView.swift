import SwiftUI

/// The service card: cover, price, variants, masters' prices, compatible jewelry, the consumption norm, work photos and
/// who got the service.
struct ServiceDetailView: View {
    @Environment(APIClient.self) private var api
    @Environment(ReferenceStore.self) private var reference
    @Environment(\.permissions) private var permissions

    let groupSuggestions: [ServiceCategory: [String]]
    let onChange: (Service) -> Void

    @State private var service: Service
    @State private var history = Remote<[HistoryEntry]>()
    @State private var historyTotal: Int?
    @State private var hasMoreHistory = false
    @State private var isLoadingMoreHistory = false
    @State private var showsEditor = false
    @State private var showsGenerator = false
    @State private var viewer: ServicePhotoViewerItem?
    /// Jewelry and consumables the service links to; loaded only when it has links.
    @State private var stock = Remote<[Product]>()
    @State private var openedProduct: Product?

    private static let historyPageSize = 50

    init(service: Service, groupSuggestions: [ServiceCategory: [String]] = [:], onChange: @escaping (Service) -> Void = { _ in }) {
        _service = State(initialValue: service)
        self.groupSuggestions = groupSuggestions
        self.onChange = onChange
    }

    var body: some View {
        List {
            coverSection
            ServiceSummarySection(service: service)
            if !service.variants.isEmpty {
                ServiceVariantsSummarySection(service: service)
            }
            if !service.masterPrices.isEmpty {
                ServiceMasterPricesCardSection(service: service)
            }
            ServiceJewelryCardSection(jewelryIds: service.jewelryIds, stock: stock, retry: loadStock) { product in
                openedProduct = product
            }
            ServiceNormsCardSection(consumables: service.consumables, stock: stock, retry: loadStock)
            photosSection
            if let description = service.description.nonEmpty {
                Section("Описание") {
                    Text(description)
                }
            }
            settingsSection
            historySection
        }
        .listSectionSpacing(.compact)
        .auraBackground()
        .navigationTitle(service.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if permissions.editsCatalog {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Изменить") { showsEditor = true }
                }
            }
        }
        .refreshable { await refresh() }
        .task {
            if history.value == nil { await loadHistory() }
        }
        .task(id: linkedIds) { await loadStockIfNeeded() }
        .navigationDestination(item: $openedProduct) { product in
            ProductDetailView(
                product: product,
                categories: jewelryCategories,
                onDelete: { id in
                    stock.remove(id: id)
                    // The server unlinks a deleted piece from its services.
                    Task { await refresh() }
                }
            ) { updated in
                applyProduct(updated)
            }
        }
        // Only names the aftercare template; on failure the row shows «—» instead of an alert.
        .task { try? await reference.ensureTemplates() }
        .remoteErrorAlert(history)
        .sheet(isPresented: $showsEditor) {
            ServiceEditorView(service: service, nextSort: service.sort, groupSuggestions: groupSuggestions) { saved in
                apply(saved)
            }
        }
        .sheet(isPresented: $showsGenerator) {
            ServiceImageGeneratorSheet(service: service) { updated in
                apply(updated)
            }
        }
        .fullScreenCover(item: $viewer) { item in
            ServicePhotoViewer(item: item)
        }
    }

    // MARK: - Sections

    private var coverSection: some View {
        Section {
            VStack(spacing: 12) {
                Button {
                    if let path = service.imageUrl.nonEmpty { viewer = ServicePhotoViewerItem(paths: [path], index: 0) }
                } label: {
                    ServiceCoverCard(path: service.imageUrl, placeholderSymbol: service.category.symbol)
                }
                .buttonStyle(.plain)
                .disabled(service.imageUrl.nonEmpty == nil)
                .accessibilityLabel(service.imageUrl.nonEmpty == nil ? "Картинки нет" : "Открыть картинку")

                if permissions.editsCatalog { generateButton }
            }
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
    }

    private var generateButton: some View {
        Button {
            showsGenerator = true
        } label: {
            Label(
                service.imageUrl.nonEmpty == nil ? "Сгенерировать картинку" : "Сгенерировать заново",
                systemImage: "wand.and.sparkles"
            )
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glass)
        .controlSize(.large)
    }

    private var photosSection: some View {
        Section {
            if service.photos.isEmpty {
                Text("Фото готовых работ пока нет — добавьте их в редакторе услуги.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ServicePhotoStrip(paths: service.photos) { index in
                    viewer = ServicePhotoViewerItem(paths: service.photos, index: index)
                }
                .listRowInsets(EdgeInsets(top: 12, leading: 0, bottom: 12, trailing: 0))
            }
        } header: {
            Text("Фото работ")
        }
    }

    private var settingsSection: some View {
        Section {
            LabeledContent(service.category.freshProcedureTitle, value: service.freshProcedure ? "Да" : "Нет")
            LabeledContent("Памятка", value: aftercareTitle)
            LabeledContent("Спросить, как заживает", value: ServiceFollowUpText.healing(service.healingCheckDays))
            if service.category == .piercing || service.jewelryChangeWeeks != nil {
                LabeledContent("Замена украшения", value: ServiceFollowUpText.jewelryChange(service.jewelryChangeWeeks))
            }
            LabeledContent("Статус", value: service.active ? "Активна" : "Скрыта")
            LabeledContent("Порядок в списке", value: "\(service.sort)")
        } footer: {
            if !service.active {
                Text("Скрытые услуги не показываются при записи, в кассе и боту.")
            }
        }
    }

    private var aftercareTitle: String {
        guard service.freshProcedure else { return "Не отправляется" }
        guard let id = service.aftercareTemplateId else { return "Без памятки" }
        return reference.template(id: id)?.name ?? "—"
    }

    private var historySection: some View {
        Section {
            if let entries = history.value {
                if entries.isEmpty {
                    Text("Эту услугу ещё никому не делали")
                        .foregroundStyle(.secondary)
                }
                ForEach(entries) { entry in
                    HistoryEntryLink(entry: entry, showsClient: true)
                }
                if hasMoreHistory {
                    Button {
                        Task { await loadMoreHistory() }
                    } label: {
                        Group {
                            if isLoadingMoreHistory { ProgressView() } else { Text("Показать ещё") }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .disabled(isLoadingMoreHistory)
                }
            } else if let failure = history.failure {
                VStack(alignment: .leading, spacing: 8) {
                    Text(failure).foregroundStyle(.secondary)
                    Button("Повторить") { Task { await loadHistory() } }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        } header: {
            HStack {
                Text("Кому делали")
                Spacer()
                if let historyTotal, historyTotal > 0 {
                    Text("\(historyTotal)").monospacedDigit()
                }
            }
        }
    }

    // MARK: - Data

    /// Products the card shows: linked jewelry and the consumables of the norm.
    private var linkedIds: [Int] { service.jewelryIds + service.consumables.map(\.productId) }

    /// Suggestions for the jewelry editor opened from a linked piece.
    private var jewelryCategories: Set<String> {
        Set(reference.categories.orderedNames(.jewelry, including: (stock.value ?? []).compactMap(\.category)))
    }

    private func refresh() async {
        do {
            let all = try await api.services(includeInactive: true)
            if let fresh = all.first(where: { $0.id == service.id }) { apply(fresh) }
        } catch is CancellationError {
            return
        } catch {
            history.transientError = error.userMessage
        }
        if !linkedIds.isEmpty { await loadStock() }
        await loadHistory()
    }

    private func loadStock() async {
        await stock.load { try await api.serviceLinkProducts() }
    }

    /// Loads the warehouse once the service has links, and again when it links a product not loaded yet.
    private func loadStockIfNeeded() async {
        guard !linkedIds.isEmpty else { return }
        let known = Set((stock.value ?? []).map(\.id))
        guard stock.value == nil || linkedIds.contains(where: { !known.contains($0) }) else { return }
        await loadStock()
    }

    /// A piece edited from the card. Its suitable services are the same link as the service's jewelry,
    /// so a changed link reloads the service.
    private func applyProduct(_ product: Product) {
        stock.upsert(product)
        let linkedHere = service.jewelryIds.contains(product.id)
        if product.kind == .jewelry, product.serviceIds.contains(service.id) != linkedHere {
            Task { await refresh() }
        }
    }

    private func loadHistory() async {
        let id = service.id
        await history.load {
            let page = try await api.serviceHistory(id: id, limit: Self.historyPageSize)
            historyTotal = page.total
            hasMoreHistory = ServiceHistoryPaging.hasMore(
                loaded: page.items.count, total: page.total,
                lastPageCount: page.items.count, pageSize: Self.historyPageSize
            )
            return page.items
        }
    }

    private func loadMoreHistory() async {
        guard let items = history.value, hasMoreHistory, !isLoadingMoreHistory else { return }
        isLoadingMoreHistory = true
        defer { isLoadingMoreHistory = false }
        do {
            let page = try await api.serviceHistory(id: service.id, limit: Self.historyPageSize, offset: items.count)
            let merged = ServiceHistoryPaging.appending(page.items, to: items)
            history.set(merged)
            historyTotal = page.total ?? historyTotal
            hasMoreHistory = ServiceHistoryPaging.hasMore(
                loaded: merged.count, total: page.total,
                lastPageCount: page.items.count, pageSize: Self.historyPageSize
            )
        } catch is CancellationError {
            return
        } catch {
            history.transientError = error.userMessage
        }
    }

    private func apply(_ updated: Service) {
        service = updated
        reference.upsertCatalogService(updated)
        onChange(updated)
    }
}

// MARK: - Pieces

/// Name, category, group, price and duration.
private struct ServiceSummarySection: View {
    let service: Service

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    StatusBadge(text: service.category.title, color: .accentColor, systemImage: service.category.symbol)
                    if let group = service.group.nonEmpty, group != service.category.title {
                        StatusBadge(text: group, color: .secondary)
                    }
                    if !service.active {
                        StatusBadge(text: "Скрыта", color: .gray, systemImage: "eye.slash")
                    }
                }
                Text(service.name)
                    .font(.title2.weight(.bold))
                    .textSelection(.enabled)
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(service.priceText)
                        .font(.title3.weight(.semibold))
                        .monospacedDigit()
                    Spacer(minLength: 8)
                    Label(DateText.duration(minutes: service.durationMin), systemImage: "clock")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if service.requiresDeposit {
                    Label("Предоплата \(Money.format(service.depositAmount))", systemImage: DepositStyle.symbol)
                        .font(.subheadline.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
        }
    }
}

private struct ServiceVariantsSummarySection: View {
    let service: Service

    var body: some View {
        Section {
            ForEach(Array(service.variants.enumerated()), id: \.offset) { _, variant in
                HStack(alignment: .firstTextBaseline) {
                    Text(variant.name)
                    Spacer(minLength: 12)
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(Money.format(variant.price))
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                        if let duration = variant.durationMin {
                            Text(DateText.duration(minutes: duration))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("Варианты")
        } footer: {
            Text("При записи выбирают один вариант — в записи будет «\(service.lineName(variant: service.variants.first))» с ценой и длительностью варианта.")
        }
    }
}

/// Large schematic cover on a white card; the category icon when there is no picture.
struct ServiceCoverCard: View {
    @Environment(APIClient.self) private var api
    let path: String?
    let placeholderSymbol: String

    private static let maxWidth: CGFloat = 420
    private static let imagePadding: CGFloat = 16

    var body: some View {
        ZStack {
            if let url = api.mediaURL(for: path) {
                Color.white
                AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.2))) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFit().padding(Self.imagePadding)
                    case .failure:
                        placeholder(symbol: "photo.badge.exclamationmark", text: "Не удалось загрузить картинку")
                    default:
                        ProgressView()
                    }
                }
            } else {
                Color(.secondarySystemGroupedBackground)
                placeholder(symbol: placeholderSymbol, text: "Картинки пока нет")
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .frame(maxWidth: Self.maxWidth)
        .frame(maxWidth: .infinity)
        .clipShape(.rect(cornerRadius: Theme.cardRadius))
    }

    private func placeholder(symbol: String, text: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 52))
            Text(text)
                .font(.subheadline)
        }
        .foregroundStyle(.secondary)
    }
}

/// Horizontal strip of work photos; tap opens the viewer at that photo.
private struct ServicePhotoStrip: View {
    let paths: [String]
    let onOpen: (Int) -> Void

    private static let size: CGFloat = 104

    var body: some View {
        ScrollView(.horizontal) {
            LazyHStack(spacing: 10) {
                ForEach(Array(paths.enumerated()), id: \.offset) { index, path in
                    Button {
                        onOpen(index)
                    } label: {
                        ProductThumbnail(path: path, size: Self.size, placeholderSymbol: "photo")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Фото \(index + 1) из \(paths.count)")
                }
            }
            .padding(.horizontal, 16)
        }
        .scrollIndicators(.hidden)
    }
}

#if DEBUG
#Preview {
    var nipple = PreviewData.nipple
    nipple.jewelryIds = [1, 2]
    nipple.consumables = [ServiceConsumable(productId: 3, quantity: 2)]
    return NavigationStack {
        ServiceDetailView(service: nipple)
    }
    .previewEnvironment()
}
#endif
