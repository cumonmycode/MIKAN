import SwiftUI

/// Multi-select of the section's products to put into a category: «Без категории» first, then the other categories in
/// staff order (a product from another category moves). Hands the picked products back.
struct CategoryItemsPicker: View {
    @Environment(\.dismiss) private var dismiss
    let category: CatalogCategory
    /// The whole section, the category's own items included (they are left out).
    let products: [Product]
    let registry: [CatalogCategory]
    let onAdd: ([Product]) -> Void

    @State private var selected: Set<Int> = []
    @State private var search = ""

    private static let thumbnailSize: CGFloat = 44

    private var groups: [ProductGroup<Product>] {
        CategoryMembership.candidates(
            for: category.name, section: category.section, in: products, registry: registry, query: search
        )
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(groups) { group in
                    Section {
                        ForEach(group.items) { product in
                            row(product)
                        }
                    } header: {
                        Text(group.category.map { "Сейчас в «\($0)»" } ?? WarehouseGrouping.uncategorizedTitle)
                    }
                }
            }
            .overlay {
                if groups.isEmpty {
                    if search.trimmed.isEmpty {
                        ContentUnavailableView(
                            "Добавлять некого",
                            systemImage: "checkmark.circle",
                            description: Text("Все позиции раздела уже в «\(category.name)».")
                        )
                    } else {
                        ContentUnavailableView.search(text: search)
                    }
                }
            }
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Название или артикул")
            .navigationTitle("В «\(category.name)»")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(selected.isEmpty ? "Добавить" : "Добавить (\(selected.count))", action: add)
                        .disabled(selected.isEmpty)
                }
            }
        }
    }

    private func row(_ product: Product) -> some View {
        let isSelected = selected.contains(product.id)
        return Button {
            if isSelected { selected.remove(product.id) } else { selected.insert(product.id) }
        } label: {
            HStack(spacing: 12) {
                ProductThumbnail(path: product.photoUrl, size: Self.thumbnailSize)
                VStack(alignment: .leading, spacing: 2) {
                    Text(product.name)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    if !product.detailLine.isEmpty {
                        Text(product.detailLine)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
                    .accessibilityHidden(true)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    /// Every picked product, also ones the current search hides.
    private func add() {
        let picked = products.filter { selected.contains($0.id) }
        dismiss()
        onAdd(picked)
    }
}
