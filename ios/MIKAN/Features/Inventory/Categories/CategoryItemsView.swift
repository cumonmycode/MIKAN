import SwiftUI

/// The items of one product category (from «Категории …»): open a card, add items of the section — from «Без категории»
/// or another category — and take an item out (it stays on the warehouse, «Без категории»).
struct CategoryItemsView: View {
    @Environment(APIClient.self) private var api
    @Environment(ReferenceStore.self) private var reference
    let category: CatalogCategory
    /// Called after every change the server accepted.
    let onChange: () -> Void

    @State private var products = Remote<[Product]>()
    @State private var showsPicker = false
    @State private var progress: String?
    @State private var errorMessage: String?

    private var members: [Product] { CategoryMembership.members(of: category.name, in: products.value ?? []) }
    private var isMoving: Bool { progress != nil }

    var body: some View {
        List {
            if !members.isEmpty {
                Section {
                    ForEach(members) { product in
                        row(product)
                    }
                } footer: {
                    Text("Смахните позицию влево, чтобы убрать её из категории, — она останется на складе «Без категории».")
                }
            }
        }
        .overlay {
            RemoteStateOverlay(
                remote: products,
                isEmpty: { CategoryMembership.members(of: category.name, in: $0).isEmpty },
                retry: load
            ) {
                ContentUnavailableView {
                    Label("В категории пусто", systemImage: "folder")
                } description: {
                    Text("Добавьте сюда позиции раздела «\(category.section.title)».")
                } actions: {
                    Button("Добавить позиции") { showsPicker = true }
                        .buttonStyle(.glassProminent)
                }
            }
        }
        .safeAreaInset(edge: .bottom) { progressBanner }
        .refreshable { await load() }
        .task { await load() }
        .remoteErrorAlert(products)
        .navigationTitle(category.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Добавить позиции", systemImage: "plus") { showsPicker = true }
                    .disabled(isMoving || products.value == nil)
            }
        }
        .sheet(isPresented: $showsPicker) {
            CategoryItemsPicker(category: category, products: products.value ?? [], registry: reference.categories) { picked in
                move(picked, to: category.name)
            }
        }
        .errorAlert($errorMessage)
    }

    private func row(_ product: Product) -> some View {
        NavigationLink {
            ProductDetailView(product: product, onDelete: { id in products.remove(id: id) }) { updated in
                products.upsert(updated)
            }
        } label: {
            ProductRow(product: product)
        }
        .swipeActions(edge: .trailing) {
            Button("Убрать", systemImage: "folder.badge.minus", role: .destructive) { move([product], to: nil) }
        }
        .contextMenu {
            Button("Убрать из категории", systemImage: "folder.badge.minus", role: .destructive) { move([product], to: nil) }
        }
        .disabled(isMoving)
    }

    @ViewBuilder
    private var progressBanner: some View {
        if let progress {
            Label {
                Text(progress)
            } icon: {
                ProgressView()
            }
            .font(.footnote.weight(.medium))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .glassEffect(.regular, in: .capsule)
            .padding(.bottom, 4)
        }
    }

    private func load() async {
        guard let kind = category.section.productKind else { return }
        await products.load { try await api.products(kind: kind, includeInactive: true) }
    }

    /// Moves the products one by one (into the category, or out of any with `nil`); stops at the first failure.
    private func move(_ items: [Product], to name: String?) {
        guard !items.isEmpty, !isMoving else { return }
        Task {
            var moved = 0
            for product in items {
                progress = CategoryMembership.progressText(done: moved, total: items.count)
                do {
                    products.upsert(try await api.setProductCategory(id: product.id, category: name))
                    moved += 1
                } catch is CancellationError {
                    break
                } catch {
                    errorMessage = CategoryMembership.failureText(moved: moved, total: items.count, reason: error.userMessage)
                    break
                }
            }
            progress = nil
            if moved > 0 { onChange() }
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        CategoryItemsView(category: CatalogCategory(id: 1, section: .jewelry, serviceCategory: nil, name: "Лабрет", position: 0, itemCount: 2)) {}
    }
    .previewEnvironment()
}
#endif
