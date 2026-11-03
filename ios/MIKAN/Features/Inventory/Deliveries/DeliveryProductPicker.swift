import SwiftUI

/// Adds products to a delivery: search across jewelry, goods and counted consumables. A tap adds one unit of a
/// product without sizes; a product with sizes opens them to type the quantity of each.
struct DeliveryProductPicker: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    @Binding var draft: DeliveryDraft

    @State private var products = Remote<[Product]>()
    @State private var search = ""
    /// `nil` — every kind.
    @State private var kind: ProductKind?

    private var found: [Product] {
        DeliveryCatalog.filter(products.value ?? [], kind: kind, query: search)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Раздел", selection: $kind) {
                        Text("Все").tag(ProductKind?.none)
                        ForEach(DeliveryCatalog.kinds) { kind in
                            Text(kind.title).tag(ProductKind?.some(kind))
                        }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                Section {
                    ForEach(found) { product in
                        row(product)
                    }
                } footer: {
                    Text("Расходники «есть / нет» здесь не показаны: их покупку записывают суммой в карточке расходника.")
                }
            }
            .searchable(
                text: $search,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Название, артикул, размер, поставщик"
            )
            .overlay {
                RemoteStateOverlay(remote: products, isEmpty: { _ in found.isEmpty }, retry: load) {
                    if search.trimmed.isEmpty {
                        ContentUnavailableView("Нечего добавить", systemImage: "shippingbox", description: Text("В этом разделе склада пока нет позиций."))
                    } else {
                        ContentUnavailableView.search(text: search)
                    }
                }
            }
            .navigationTitle("Добавить в поставку")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Product.self) { product in
                DeliverySizesView(product: product, draft: $draft)
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Готово") { dismiss() }
                }
            }
            .sensoryFeedback(.increase, trigger: draft.units)
            .task {
                guard products.value == nil else { return }
                await load()
            }
        }
    }

    @ViewBuilder
    private func row(_ product: Product) -> some View {
        let inDelivery = draft.quantity(ofProduct: product.id)
        if product.hasSeveralSizes {
            NavigationLink(value: product) {
                DeliveryProductRow(product: product, inDelivery: inDelivery)
            }
        } else {
            Button {
                add(product)
            } label: {
                DeliveryProductRow(product: product, inDelivery: inDelivery)
            }
            .tint(.primary)
            .accessibilityHint("Добавляет одну единицу в поставку")
        }
    }

    private func add(_ product: Product) {
        guard let variant = product.variants.first else { return }
        withAnimation(.snappy) { draft = draft.adding(product, variantId: variant.id) }
    }

    /// Each kind is the warehouse's own list (kept on the phone for offline use).
    private func load() async {
        await products.load {
            var all: [Product] = []
            for kind in DeliveryCatalog.kinds {
                all += try await api.products(kind: kind, includeInactive: true)
            }
            return DeliveryCatalog.options(all)
        }
    }
}

private struct DeliveryProductRow: View {
    let product: Product
    /// Units of it already in the delivery.
    let inDelivery: Int

    var body: some View {
        HStack(spacing: 12) {
            ProductThumbnail(path: product.photoUrl, size: 44, placeholderSymbol: CatalogSection(kind: product.kind).symbol)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(product.name)
                        .font(.body.weight(.medium))
                        .lineLimit(2)
                    if !product.active {
                        StatusBadge(text: "Скрыто", color: .gray)
                    }
                }
                Text(details)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .monospacedDigit()
            }
            Spacer(minLength: 8)
            if inDelivery > 0 {
                StatusBadge(text: "+\(inDelivery)", color: .green)
            } else if !product.hasSeveralSizes {
                Image(systemName: "plus.circle")
                    .font(.title3)
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }

    /// «6 мм · 8 мм · 10 мм», or the stock of a product without sizes.
    private var details: String {
        let stock = "на складе \(InventoryText.quantity(product.quantity, unit: product.unitLabel))"
        guard product.hasSeveralSizes else { return "\(product.kind.singularTitle) · \(stock)" }
        return "\(product.sizesSummary) · \(stock)"
    }
}

/// The sizes of one product: how many of each came. Applied when leaving the screen; a size left empty is not in
/// the delivery.
struct DeliverySizesView: View {
    @Environment(\.dismiss) private var dismiss
    let product: Product
    @Binding var draft: DeliveryDraft
    @State private var quantities: [Int: Int]

    init(product: Product, draft: Binding<DeliveryDraft>) {
        self.product = product
        _draft = draft
        let current = product.variants.compactMap { variant in
            draft.wrappedValue.line(variantId: variant.id)?.quantity.map { (variant.id, $0) }
        }
        _quantities = State(initialValue: Dictionary(current, uniquingKeysWith: { first, _ in first }))
    }

    private var total: Int { quantities.values.reduce(0, +) }

    var body: some View {
        Form {
            Section {
                ForEach(product.variants) { variant in
                    VStack(alignment: .leading, spacing: 4) {
                        NumberField(
                            title: InventoryText.sizeTitle(variant.name),
                            value: binding(variant.id),
                            suffix: product.unitLabel,
                            groupsDigits: false,
                            placeholder: "0"
                        )
                        Text(details(variant))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    .padding(.vertical, 2)
                }
            } header: {
                Text(product.name)
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Сколько единиц каждого размера пришло. Размеры без количества в поставку не попадут.")
                    if total > 0 {
                        Text("Итого: \(InventoryText.quantity(total, unit: product.unitLabel))")
                            .fontWeight(.semibold)
                            .monospacedDigit()
                    }
                }
            }
        }
        .navigationTitle("Размеры")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Готово") {
                    apply()
                    dismiss()
                }
            }
        }
        // A swipe back keeps what was typed too.
        .onDisappear(perform: apply)
    }

    private func binding(_ variantId: Int) -> Binding<Int?> {
        Binding(get: { quantities[variantId] }, set: { quantities[variantId] = $0 })
    }

    /// «На складе 4 шт · закупка 700 ₽».
    private func details(_ variant: ProductVariant) -> String {
        var parts = ["На складе \(InventoryText.quantity(variant.quantity, unit: product.unitLabel))"]
        if let cost = product.cost(of: variant) { parts.append("закупка \(Money.format(cost))") }
        return parts.joined(separator: " · ")
    }

    private func apply() {
        let updated = draft.settingQuantities(quantities, of: product)
        if updated != draft { draft = updated }
    }
}
