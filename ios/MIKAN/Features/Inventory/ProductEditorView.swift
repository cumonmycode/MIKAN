import SwiftUI

/// Product card editor for every kind. Jewelry: characteristics, sizes, prices, suitable services. Goods: sizes or
/// volumes, prices, supplier. Consumables: counted or «есть / нет», and the services that use them.
struct ProductEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    @Environment(ReferenceStore.self) private var reference

    let product: Product?
    /// Category names seen on the warehouse; offered only while the categories registry is not loaded.
    let categories: Set<String>
    /// Runs after an existing product was deleted; the editor closes itself.
    let onDeleted: (Int) -> Void
    let onSaved: (Product) -> Void

    @State private var draft: ProductDraft
    @State private var isUploading = false
    @State private var isSaving = false
    @State private var confirmsDelete = false
    @State private var isDeleting = false
    @State private var errorMessage: String?

    init(
        product: Product?,
        defaultKind: ProductKind,
        categories: Set<String> = [],
        onDeleted: @escaping (Int) -> Void = { _ in },
        onSaved: @escaping (Product) -> Void
    ) {
        self.product = product
        self.categories = categories
        self.onDeleted = onDeleted
        self.onSaved = onSaved
        _draft = State(initialValue: ProductDraft(product: product, defaultKind: defaultKind))
    }

    private var isBusy: Bool { isSaving || isUploading || isDeleting }
    private var canSave: Bool { draft.canSave && !isBusy }

    var body: some View {
        NavigationStack {
            Form {
                kindSection
                ProductPhotosEditorSection(draft: $draft, isUploading: $isUploading, errorMessage: $errorMessage)
                mainSection
                accountingSection
                if draft.isJewelry {
                    ProductCharacteristicsSection(draft: $draft)
                }
                if draft.isConsumable {
                    ConsumableStockSection(draft: $draft)
                }
                if draft.showsSizesEditor {
                    ProductSizesEditor(draft: $draft)
                }
                if draft.isJewelry {
                    servicesSection
                }
                if draft.isConsumable {
                    ConsumableUsageSection(draft: draft)
                }
                descriptionSection
                Section {
                    Toggle("Активен", isOn: $draft.active)
                } footer: {
                    Text(activeFooter)
                }
                if product != nil {
                    Section {
                        Button("Удалить", systemImage: "trash", role: .destructive) { confirmsDelete = true }
                            .disabled(isBusy)
                    } footer: {
                        Text("Продажи и история движений сохранятся.")
                    }
                }
            }
            .disabled(isSaving || isDeleting)
            .safeAreaInset(edge: .bottom) { saveBlockerBanner }
            .navigationTitle(product == nil ? "Новая позиция" : "Редактирование")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                        .disabled(isBusy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving || isDeleting { ProgressView() } else { Button("Сохранить", action: save).disabled(!canSave) }
                }
            }
            .interactiveDismissDisabled(isBusy)
            .productDeletion(product, isPresented: $confirmsDelete, isDeleting: $isDeleting, errorMessage: $errorMessage) { id in
                onDeleted(id)
                dismiss()
            }
            // Only names the linked services; pickers report their own load errors. The categories are asked again
            // every time, so ones made on another card or phone are offered too.
            .task { try? await reference.ensureServices() }
            .task { try? await reference.ensureCategories(force: true) }
            .errorAlert($errorMessage)
        }
    }

    // MARK: - Sections

    private var kindSection: some View {
        Section {
            Picker("Тип", selection: $draft.kind.animation()) {
                ForEach(ProductKind.allCases) { kind in
                    Text(kind.singularTitle).tag(kind)
                }
            }
            .pickerStyle(.segmented)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        } footer: {
            Text(kindHint)
        }
    }

    private var kindHint: String {
        switch draft.kind {
        case .jewelry: "Продаётся в кассе, бот предлагает его клиентам."
        case .goods: "Спреи, сертификаты и другое, что продаётся в кассе. Бот называет их «Товары»."
        case .consumable: "Уходит на процедуры по нормам услуг, не продаётся."
        }
    }

    private var mainSection: some View {
        Section {
            TextField("Название", text: $draft.name)
            TextField("Артикул", text: $draft.sku)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
            CategoryField(scope: categoryScope, options: categoryOptions, selection: $draft.category)
            if draft.isConsumable {
                TextField("Материал", text: $draft.material)
                if !draft.showsSizesEditor && !draft.isPresenceTracked {
                    TextField("Размер (необязательно)", text: firstSizeName)
                }
            }
        } header: {
            Text("Основное")
        } footer: {
            // Not red: on a new card an empty name is the starting point, not a mistake.
            if let message = draft.nameMessage {
                Text(message)
            }
        }
    }

    private var accountingSection: some View {
        Section {
            if draft.isSold {
                NumberField.money("Цена продажи", value: $draft.price)
            }
            NumberField.optionalMoney("Себестоимость", value: $draft.cost)
            if draft.isSold, let markup = ProductMarkup.text(price: draft.price, cost: draft.cost) {
                LabeledContent("Наценка", value: markup).monospacedDigit()
            }
            if !draft.isPresenceTracked {
                ProductUnitRow(unit: $draft.unit)
            }
            TextField("Поставщик", text: $draft.supplier)
        } header: {
            Text(draft.isSold ? "Цена и учёт" : "Закупка")
        } footer: {
            if let message = draft.unitMessage ?? draft.supplierMessage {
                Text(message).foregroundStyle(.red)
            } else if draft.isSold && draft.hasSeveralSizes {
                Text("Цена и себестоимость — для всех размеров; у размера могут быть свои.")
            } else if draft.isConsumable {
                Text("По себестоимости считается стоимость расхождений в ревизии.")
            }
        }
    }

    private var servicesSection: some View {
        Section {
            NavigationLink {
                ProductServicesPicker(draft: $draft)
            } label: {
                LabeledContent("Подходит для", value: servicesSummary)
            }
        } header: {
            Text("Подходящие услуги")
        } footer: {
            if let message = draft.servicesMessage {
                Text(message).foregroundStyle(.red)
            } else {
                Text("Зоны прокола, для которых подходит украшение. Бот называет их, когда рассказывает об украшениях.")
            }
        }
    }

    /// «Хеликс, Септум» or «Хеликс, Септум и ещё 3».
    private var servicesSummary: String {
        let names = ProductServiceOptions.names(of: draft.serviceIds, in: reference.services)
        guard !draft.serviceIds.isEmpty else { return "Не выбрано" }
        guard !names.isEmpty else { return Plural.count(draft.serviceIds.count, one: "услуга", few: "услуги", many: "услуг") }
        let shown = names.prefix(2).joined(separator: ", ")
        let rest = draft.serviceIds.count - min(2, names.count)
        return rest > 0 ? "\(shown) и ещё \(rest)" : shown
    }

    private var descriptionSection: some View {
        Section {
            TextField("Описание", text: $draft.description, axis: .vertical)
                .lineLimit(3...8)
        } header: {
            Text("Описание")
        } footer: {
            switch draft.kind {
            case .jewelry: Text("Описание видит бот, когда рассказывает клиентам об украшениях.")
            case .goods: Text("Описание видит бот, когда рассказывает клиентам о товарах.")
            case .consumable: EmptyView()
            }
        }
    }

    private var activeFooter: String {
        draft.isConsumable
            ? "Неактивные расходники остаются на складе; в ревизию попадают, только пока есть остаток."
            : "Неактивные позиции скрыты из кассы и от бота, но остаются на складе."
    }

    /// Why «Сохранить» is disabled when the reason is a field the user already touched or cannot see.
    @ViewBuilder
    private var saveBlockerBanner: some View {
        if let message = draft.validationMessage, draft.nameMessage == nil {
            Label(message, systemImage: "exclamationmark.circle")
                .font(.footnote.weight(.medium))
                .foregroundStyle(.red)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassEffect(.regular, in: .rect(cornerRadius: 16))
                .padding(.horizontal, 16)
                .padding(.bottom, 4)
                .accessibilityLabel("Нельзя сохранить: \(message)")
        }
    }

    // MARK: - Helpers

    private var categoryScope: CategoryScope { CategoryScope(section: CatalogSection(kind: draft.kind)) }

    /// The kind's categories in the staff order (with the current one, even when it is new).
    private var categoryOptions: [String] {
        let extra = reference.categories.isEmpty ? Array(categories) : []
        return WarehouseGrouping.categoryOptions(
            section: categoryScope.section,
            categories: reference.categories,
            products: [],
            extra: extra + [draft.category]
        )
    }

    /// The name of the only size (a consumable without sizes).
    private var firstSizeName: Binding<String> {
        Binding(
            get: { draft.sizes.first?.name ?? "" },
            set: { value in
                guard !draft.sizes.isEmpty else { return }
                draft.sizes[0].name = value
            }
        )
    }

    // MARK: - Save

    private func save() {
        guard draft.canSave else { return }
        let body = draft.body
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let saved = if let product {
                    try await api.updateProduct(id: product.id, body)
                } else {
                    try await api.createProduct(body)
                }
                onSaved(saved)
                dismiss()
                await reference.refreshCategoriesIfUnknown(saved.category, in: CategoryScope(section: CatalogSection(kind: saved.kind)))
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

/// «Единица» with the studio's usual units in a menu.
struct ProductUnitRow: View {
    @Binding var unit: String

    var body: some View {
        HStack {
            Text("Единица")
            Spacer()
            TextField(ProductLimits.defaultUnit, text: $unit)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 80)
            Menu {
                ForEach(ProductLimits.unitSuggestions, id: \.self) { option in
                    Button(option) { unit = option }
                }
            } label: {
                Image(systemName: "chevron.up.chevron.down")
                    .accessibilityLabel("Выбрать единицу")
            }
        }
    }
}

#if DEBUG
#Preview("Новое украшение") {
    ProductEditorView(product: nil, defaultKind: .jewelry, categories: ["Лабрет", "Кольцо"]) { _ in }
        .previewEnvironment()
}

#Preview("Лабрет с размерами") {
    ProductEditorView(product: PreviewData.labret, defaultKind: .jewelry, categories: ["Лабрет", "Кольцо"]) { _ in }
        .previewEnvironment()
}

#Preview("Расходник «есть / нет»") {
    ProductEditorView(product: PreviewData.antiseptic, defaultKind: .consumable) { _ in }
        .previewEnvironment()
}

#Preview("Товар") {
    ProductEditorView(product: PreviewData.spray, defaultKind: .goods) { _ in }
        .previewEnvironment()
}
#endif
