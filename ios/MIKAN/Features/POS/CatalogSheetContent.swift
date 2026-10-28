import SwiftUI

/// One product segment of the catalog: category chips, then a card per product (search and the chip applied).
struct CatalogProductsContent: View {
    @Environment(ReferenceStore.self) private var reference
    let kind: ProductKind
    let catalog: Remote<[Product]>
    let search: String
    @Binding var category: String?
    let reload: () async -> Void
    let onAdd: (Product, ProductVariant) -> Void

    private var products: [Product] { catalog.value ?? [] }

    var body: some View {
        let names = ProductCatalogFilter.categories(of: products, kind: kind, registry: reference.categories)
        if !names.isEmpty {
            CategoryChips(categories: names, selection: $category, size: .large)
        }
        if catalog.value != nil {
            let items = ProductCatalogFilter.apply(products, kind: kind, query: search, category: category)
            if items.isEmpty {
                emptyState
            } else {
                ForEach(items) { product in
                    CatalogProductCard(product: product) { onAdd(product, $0) }
                }
            }
        } else if let failure = catalog.failure {
            ErrorStateView(message: failure, retry: reload)
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: 160)
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        let symbol = CatalogSection(kind: kind).symbol
        if !search.trimmed.isEmpty {
            ContentUnavailableView.search(text: search)
        } else if category != nil, !ProductCatalogFilter.products(products, kind: kind).isEmpty {
            ContentUnavailableView("В этой категории пусто", systemImage: symbol)
        } else if kind == .goods {
            ContentUnavailableView(
                "Нет товаров",
                systemImage: symbol,
                description: Text("Добавьте товары — спреи для ухода, сертификаты — на вкладке «Склад» → «Товары». Они появятся здесь.")
            )
        } else {
            ContentUnavailableView(
                "Нет украшений",
                systemImage: symbol,
                description: Text("Добавьте украшения на вкладке «Склад» — они появятся здесь.")
            )
        }
    }
}

/// «Услуги»: category chips, «Своя услуга», then the services by category and group, at the master's prices.
struct CatalogServicesContent: View {
    @Environment(ReferenceStore.self) private var reference
    /// Load state of the services; they live in `ReferenceStore`.
    let state: Remote<Void>
    let search: String
    @Binding var category: ServiceCategory?
    let masterId: Int?
    let load: () async -> Void
    let onAdd: (Service, ServiceVariant?) -> Void
    /// «Своя услуга», with the name to start from.
    let onCustom: (String) -> Void

    private var services: [Service] { reference.activeServices }
    private var isSearching: Bool { !search.trimmed.isEmpty }

    private var filtered: [Service] {
        // A category that vanished after a refresh no longer filters anything out.
        let selected = category.flatMap { POSServiceCatalog.categories(of: services).contains($0) ? $0 : nil }
        return POSServiceCatalog.filter(services, category: selected, query: search)
    }

    var body: some View {
        let categories = POSServiceCatalog.categories(of: services)
        if categories.count > 1 {
            CategoryChips(categories: categories.map(\.title), selection: categoryTitle(among: categories), size: .large)
        }
        if !isSearching {
            CustomServiceCard { onCustom("") }
        }
        if state.value != nil || !services.isEmpty {
            let sections = POSServiceCatalog.sections(filtered)
            if sections.isEmpty {
                emptyState
            } else {
                let showsCategories = Set(sections.map(\.category)).count > 1
                ForEach(sections) { section in
                    let headers = section.headers(showsCategories: showsCategories)
                    if headers.category != nil || headers.group != nil {
                        ServiceSectionHeader(category: headers.category, group: headers.group)
                    }
                    ForEach(section.services) { service in
                        CatalogServiceCard(service: service, masterId: masterId) { onAdd(service, $0) }
                    }
                }
            }
            if isSearching {
                customFromSearch
            }
        } else if let failure = state.failure {
            ErrorStateView(message: failure, retry: load)
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, minHeight: 160)
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if isSearching {
            ContentUnavailableView.search(text: search)
        } else {
            ContentUnavailableView(
                "Нет услуг",
                systemImage: "sparkles",
                description: Text("Добавьте услуги в разделе «Ещё» → «Услуги». Свою услугу можно добавить кнопкой выше.")
            )
        }
    }

    /// «Добавить «пирсинг носа» как свою услугу».
    private var customFromSearch: some View {
        Button {
            onCustom(search.trimmed)
        } label: {
            Label("Добавить «\(search.trimmed)» как свою услугу", systemImage: "plus.circle")
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(.rect)
        }
        .padding(.horizontal, 4)
    }

    private func categoryTitle(among categories: [ServiceCategory]) -> Binding<String?> {
        Binding(
            get: { category?.title },
            set: { title in category = categories.first { $0.title == title } }
        )
    }
}

/// Category and/or group title above a block of service cards.
private struct ServiceSectionHeader: View {
    let category: String?
    let group: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let category {
                Text(category)
                    .font(.title3.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
            }
            if let group {
                Text(group)
                    .font(.headline)
                    .foregroundStyle(.secondary)
                    .accessibilityAddTraits(.isHeader)
            }
        }
        .padding(.top, 8)
        .padding(.horizontal, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
