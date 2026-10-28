import SwiftUI

// Parts of the product editor: jewelry characteristics, and sizes (jewelry and goods).

/// Material (with presets), thread type, thickness with the gauge hint, colour, stone.
struct ProductCharacteristicsSection: View {
    @Binding var draft: ProductDraft

    var body: some View {
        Section {
            HStack {
                TextField("Материал", text: $draft.material)
                Menu {
                    ForEach(ProductMaterial.presets, id: \.self) { preset in
                        Button {
                            draft.material = preset
                        } label: {
                            if preset == draft.material.trimmed {
                                Label(preset, systemImage: "checkmark")
                            } else {
                                Text(preset)
                            }
                        }
                    }
                } label: {
                    Image(systemName: "list.bullet.circle")
                        .accessibilityLabel("Выбрать материал")
                }
            }
            Picker("Резьба", selection: $draft.threadType) {
                Text("Не указано").tag(ThreadType?.none)
                ForEach(ThreadType.allCases) { type in
                    Text(type.title).tag(ThreadType?.some(type))
                }
            }
            HStack {
                Text("Толщина")
                Spacer(minLength: 12)
                TextField("1.2", text: $draft.thicknessText)
                    .keyboardType(.numbersAndPunctuation)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.characters)
                    .multilineTextAlignment(.trailing)
                    .monospacedDigit()
                    .frame(maxWidth: 120)
                    .accessibilityLabel("Толщина, мм")
                Text("мм").foregroundStyle(.secondary)
            }
            TextField("Цвет, например «Золотистый»", text: $draft.color)
            TextField("Камень, например «Фианит»", text: $draft.stone)
        } header: {
            Text("Характеристики")
        } footer: {
            if let message = draft.thicknessMessage ?? draft.appearanceMessage {
                Text(message).foregroundStyle(.red)
            } else if let hint = draft.thicknessHint {
                Text("Толщина: \(hint).")
            } else {
                Text("Толщину можно ввести в миллиметрах (1.2) или калибром (16G).")
            }
        }
    }
}

/// Sizes of jewelry or goods (lengths, diameters, volumes): a section per size (name, stock, minimum, own article and
/// price) and the add buttons.
struct ProductSizesEditor: View {
    @Binding var draft: ProductDraft

    @State private var showsBulkAdd = false
    @State private var bulkText = ""
    @FocusState private var focusedSize: UUID?

    var body: some View {
        // Rows bind by the size's id, not by its index: `ForEach($draft.sizes)` hands out index bindings that a row's
        // text and number fields may still read after a size above was removed or the list was rebuilt — an
        // «Index out of range» trap.
        ForEach(draft.sizes) { size in
            sizeSection(size, binding: binding(for: size.id))
        }
        Section {
            Button("Добавить размер", systemImage: "plus.circle.fill", action: addSize)
                .disabled(draft.sizes.count >= ProductLimits.maxSizes)
            Button("Добавить размеры списком…", systemImage: "text.badge.plus") { showsBulkAdd = true }
                .disabled(draft.sizes.count >= ProductLimits.maxSizes)
                .alert("Добавить размеры", isPresented: $showsBulkAdd) {
                    TextField(draft.kind == .goods ? "50, 100, 200 мл" : "6, 8, 10 мм", text: $bulkText)
                    Button("Добавить", action: addBulk)
                    Button("Отмена", role: .cancel) { bulkText = "" }
                } message: {
                    Text("Через запятую. Единицу достаточно написать у последнего: «6, 8, 10 мм». Дробные — через точку: «1.2×8 мм».")
                }
        } footer: {
            if let message = draft.sizesMessage {
                Text(message).foregroundStyle(.red)
            } else if draft.hasSeveralSizes {
                Text("Остаток считается по каждому размеру; в кассе при продаже выбирают размер.")
            } else if draft.kind == .goods {
                Text("Если товар бывает разного объёма или размера (50 мл, 100 мл), добавьте их — остаток будет считаться по каждому.")
            } else {
                Text("Если украшение бывает разной длины или диаметра, добавьте размеры — остаток будет считаться по каждому.")
            }
        }
    }

    private var exampleSize: String { draft.kind == .goods ? "100 мл" : "8 мм" }

    private func sizeSection(_ size: SizeDraft, binding: Binding<SizeDraft>) -> some View {
        Section {
            TextField(
                draft.hasSeveralSizes ? "Название, например «\(exampleSize)»" : "Размер, если есть (необязательно)",
                text: binding.name
            )
            .focused($focusedSize, equals: size.id)
            if size.isNew {
                NumberField.integer("Начальный остаток", value: binding.initialQuantity, unit: draft.unitLabel)
            } else {
                LabeledContent("На складе", value: InventoryText.quantity(size.quantity, unit: draft.unitLabel))
                    .monospacedDigit()
            }
            NumberField.integer("Минимальный остаток", value: binding.minQuantity, unit: draft.unitLabel)
            if draft.hasSeveralSizes || size.hasOwnValues {
                NavigationLink {
                    ProductSizeOwnValuesView(size: binding, productSku: draft.sku, productPrice: draft.price, productCost: draft.cost)
                } label: {
                    LabeledContent("Артикул и цена", value: ownValuesSummary(size))
                }
            }
        } header: {
            header(for: size)
        }
    }

    /// The size with this id; once it is gone, reads give a blank row and writes are dropped instead of trapping.
    private func binding(for id: UUID) -> Binding<SizeDraft> {
        Binding(
            get: { draft.sizes.first { $0.id == id } ?? SizeDraft(id: id) },
            set: { value in
                guard let index = draft.sizes.firstIndex(where: { $0.id == id }) else { return }
                draft.sizes[index] = value
            }
        )
    }

    /// Takes the focus off the size first, so its field does not commit into a row that no longer exists.
    private func remove(_ id: UUID) {
        if focusedSize == id { focusedSize = nil }
        draft = draft.removingSize(id)
    }

    private func header(for size: SizeDraft) -> some View {
        let index = draft.sizes.firstIndex { $0.id == size.id } ?? 0
        let removalBlock = draft.removalBlock(for: size.id)
        return HStack {
            Text(draft.hasSeveralSizes ? "Размер \(index + 1)" : "Размер и остаток")
            Spacer()
            if draft.hasSeveralSizes {
                Menu {
                    Button("Выше", systemImage: "arrow.up") {
                        draft = draft.movingSize(size.id, by: -1)
                    }
                    .disabled(index == 0)
                    Button("Ниже", systemImage: "arrow.down") {
                        draft = draft.movingSize(size.id, by: 1)
                    }
                    .disabled(index >= draft.sizes.count - 1)
                    Divider()
                    Button("Удалить размер", systemImage: "trash", role: .destructive) {
                        remove(size.id)
                    }
                    .disabled(removalBlock != nil)
                    if let removalBlock {
                        Text(removalBlock)
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.body)
                        .accessibilityLabel("Действия с размером \(index + 1)")
                }
            }
        }
    }

    /// «как у товара» or «LB-12-10 · 1 700 ₽».
    private func ownValuesSummary(_ size: SizeDraft) -> String {
        guard size.hasOwnValues else { return "как у товара" }
        let parts = [size.sku.nonEmpty, size.price.map { Money.format($0) }, size.cost.map { "себест. \(Money.format($0))" }]
        return parts.compactMap { $0 }.joined(separator: " · ")
    }

    private func addSize() {
        let updated = draft.addingSize()
        draft = updated
        // The new row's text field exists only after this update, so focus it on the next turn.
        if let id = updated.sizes.last?.id {
            Task { focusedSize = id }
        }
    }

    private func addBulk() {
        let names = ProductSizeNames.parse(bulkText)
        bulkText = ""
        guard !names.isEmpty else { return }
        focusedSize = nil
        // Not animated, and after the alert has let go of its row: inserting several sections while the alert and
        // the keyboard are still going away is a batch update the form's collection view may reject.
        Task {
            await Task.yield()
            draft = draft.addingSizes(named: names)
        }
    }
}

/// Own article, price and cost of one size; empty fields fall back to the product's.
struct ProductSizeOwnValuesView: View {
    @Binding var size: SizeDraft
    let productSku: String
    let productPrice: Int
    let productCost: Int?

    var body: some View {
        Form {
            Section {
                TextField(productSku.nonEmpty ?? "Артикул размера", text: $size.sku)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
            } header: {
                Text("Артикул")
            } footer: {
                Text(productSku.nonEmpty.map { "Пусто — артикул товара «\($0)»." } ?? "Пусто — без своего артикула.")
            }
            Section {
                NumberField.optionalMoney("Цена продажи", value: $size.price, placeholder: Money.format(productPrice))
                NumberField.optionalMoney("Себестоимость", value: $size.cost, placeholder: productCost.map(Money.format) ?? "—")
                if let markup = ProductMarkup.text(price: size.price ?? productPrice, cost: size.cost ?? productCost) {
                    LabeledContent("Наценка", value: markup).monospacedDigit()
                }
            } header: {
                Text("Цена")
            } footer: {
                Text("Пустые поля — цена и себестоимость товара. Своя цена нужна, если размер стоит иначе.")
            }
            if size.hasOwnValues {
                Section {
                    Button("Как у товара", systemImage: "arrow.uturn.backward") {
                        size.sku = ""
                        size.price = nil
                        size.cost = nil
                    }
                }
            }
        }
        .navigationTitle(InventoryText.sizeTitle(size.name))
        .navigationBarTitleDisplayMode(.inline)
    }
}
