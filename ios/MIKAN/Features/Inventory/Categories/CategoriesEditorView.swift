import SwiftUI

/// What the name alert is for: a new category of a scope, or renaming one.
private enum CategoryNameRequest: Identifiable, Hashable {
    case add(ServiceCategory?)
    case rename(CatalogCategory)

    var id: String {
        switch self {
        case .add(let scope): "add:\(scope?.rawValue ?? "")"
        case .rename(let category): "rename:\(category.id)"
        }
    }
}

/// Categories of one warehouse section (services: per Тату / Пирсинг / Другое): add, rename (items follow), drag to
/// reorder, merge into another category, delete (items stay without a category). Keeps `ReferenceStore` in sync.
struct CategoriesEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    @Environment(ReferenceStore.self) private var reference
    let section: CatalogSection
    /// Called after every change the server accepted.
    let onChange: () -> Void

    @State private var categories = Remote<[CatalogCategory]>()
    @State private var search = ""
    @State private var editMode: EditMode = .inactive
    @State private var nameRequest: CategoryNameRequest?
    @State private var nameText = ""
    @State private var merging: CatalogCategory?
    @State private var deleting: CatalogCategory?
    /// The product category whose items are open.
    @State private var opened: CatalogCategory?
    @State private var isWorking = false
    @State private var errorMessage: String?

    private var scopes: [ServiceCategory?] { CategoryEditing.scopes(of: section) }
    private var isSearching: Bool { !search.trimmed.isEmpty }
    /// Product categories open their items on a tap; service groups are renamed (services are edited in their cards).
    private var opensItems: Bool { section.productKind != nil }

    var body: some View {
        NavigationStack {
            List {
                ForEach(scopes, id: \.self) { scope in
                    scopeSection(scope)
                }
            }
            .environment(\.editMode, $editMode)
            .navigationDestination(item: $opened) { category in
                CategoryItemsView(category: category, onChange: itemsChanged)
            }
            .searchable(text: $search, prompt: "Найти категорию")
            .overlay {
                RemoteStateOverlay(remote: categories, retry: load)
            }
            .refreshable { await load() }
            .task { await load() }
            .remoteErrorAlert(categories)
            .navigationTitle("Категории \(section.genitiveTitle)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .alert(nameAlertTitle, isPresented: nameAlertBinding, presenting: nameRequest) { request in
                TextField("Название", text: $nameText)
                Button(isRename(request) ? "Сохранить" : "Добавить") { submitName(request) }
                Button("Отмена", role: .cancel) {}
            } message: { request in
                Text(nameAlertMessage(request))
            }
            .confirmationDialog(
                deleting.map { "Удалить категорию «\($0.name)»?" } ?? "",
                isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                titleVisibility: .visible,
                presenting: deleting
            ) { category in
                Button("Удалить", role: .destructive) { delete(category) }
                Button("Отмена", role: .cancel) {}
            } message: { category in
                Text(category.itemCount > 0
                    ? "Её содержимое (\(CategoryEditing.countText(category.itemCount, section: section))) останется — «Без категории»."
                    : "В категории ничего нет.")
            }
            .sheet(item: $merging) { source in
                CategoryMergeSheet(source: source, targets: targets(for: source)) { target in
                    merge(source, into: target)
                }
            }
            .errorAlert($errorMessage)
            .disabled(isWorking)
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private func scopeSection(_ scope: ServiceCategory?) -> some View {
        let items = visibleItems(scope)
        Section {
            ForEach(items) { category in
                row(category)
            }
            .onMove { source, destination in move(scope, from: source, to: destination) }
            .moveDisabled(isSearching)
            if !isSearching && editMode == .inactive {
                Button("Новая категория", systemImage: "plus.circle.fill") { startAdding(scope) }
            }
        } header: {
            if let scope {
                Label(scope.title, systemImage: scope.symbol)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(.primary)
                    .textCase(nil)
            }
        } footer: {
            if scope == scopes.last, !isSearching {
                Text(opensItems
                    ? "Нажмите на категорию, чтобы добавить в неё позиции или убрать их. Порядок категорий — тот же на складе, в кассе и у бота: удерживайте строку и перетащите её или нажмите «Порядок»."
                    : "Порядок категорий — тот же на складе, в кассе и у бота. Удерживайте строку и перетащите её или нажмите «Порядок».")
            }
        }
    }

    private func row(_ category: CatalogCategory) -> some View {
        Button {
            guard editMode == .inactive else { return }
            if opensItems { opened = category } else { startRenaming(category) }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(category.name)
                        .foregroundStyle(.primary)
                    Text(CategoryEditing.countText(category.itemCount, section: section))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                Spacer(minLength: 8)
                if editMode == .inactive {
                    Image(systemName: opensItems ? "chevron.right" : "pencil")
                        .font(.footnote.weight(opensItems ? .semibold : .regular))
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(.rect)
        }
        .tint(.primary)
        .accessibilityHint(opensItems ? "Открыть позиции категории" : "Переименовать")
        .swipeActions(edge: .leading) {
            Button("Переименовать", systemImage: "pencil") { startRenaming(category) }
                .tint(.blue)
        }
        .swipeActions(edge: .trailing) {
            Button("Удалить", systemImage: "trash", role: .destructive) { deleting = category }
            Button("Объединить", systemImage: "arrow.triangle.merge") { merging = category }
                .tint(.indigo)
                .disabled(targets(for: category).isEmpty)
        }
        .contextMenu {
            if opensItems {
                Button("Позиции категории", systemImage: "list.bullet") { opened = category }
            }
            Button("Переименовать", systemImage: "pencil") { startRenaming(category) }
            Button("Объединить с…", systemImage: "arrow.triangle.merge") { merging = category }
                .disabled(targets(for: category).isEmpty)
            Divider()
            Button("Удалить", systemImage: "trash", role: .destructive) { deleting = category }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Закрыть", systemImage: "xmark") { dismiss() }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button(editMode == .active ? "Готово" : "Порядок") {
                withAnimation { editMode = editMode == .active ? .inactive : .active }
            }
            .disabled(isSearching || (categories.value ?? []).isEmpty)
        }
        ToolbarItem(placement: .topBarTrailing) {
            if section == .service {
                Menu {
                    ForEach(ServiceCategory.allCases) { scope in
                        Button(scope.title, systemImage: scope.symbol) { startAdding(scope) }
                    }
                } label: {
                    Label("Новая категория", systemImage: "plus")
                }
            } else {
                Button("Новая категория", systemImage: "plus") { startAdding(nil) }
            }
        }
    }

    // MARK: - Data

    private func scopeItems(_ scope: ServiceCategory?) -> [CatalogCategory] {
        (categories.value ?? []).scope(section, serviceCategory: scope)
    }

    private func visibleItems(_ scope: ServiceCategory?) -> [CatalogCategory] {
        let items = scopeItems(scope)
        guard isSearching else { return items }
        let query = InventoryFilter.normalized(search)
        return items.filter { InventoryFilter.normalized($0.name).contains(query) }
    }

    /// Categories the source can be merged into: the rest of its scope.
    private func targets(for source: CatalogCategory) -> [CatalogCategory] {
        scopeItems(source.serviceCategory).filter { $0.id != source.id }
    }

    private func load() async {
        let section = section
        await categories.load { try await api.catalogCategories(section: section) }
        if let value = categories.value { reference.replaceCategories(value, section: section) }
    }

    /// Shows the new list at once and hands it to the rest of the app.
    private func apply(_ items: [CatalogCategory]) {
        categories.set(items)
        reference.replaceCategories(items, section: section)
    }

    /// Items moved in or out of a category: the counts here and the warehouse list are out of date.
    private func itemsChanged() {
        onChange()
        Task { await load() }
    }

    /// Runs one change; a failure reloads the list from the server, so nothing optimistic stays behind.
    private func perform(_ change: @escaping @MainActor () async throws -> Void) {
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                try await change()
                onChange()
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
                await load()
            }
        }
    }

    // MARK: - Actions

    private func startAdding(_ scope: ServiceCategory?) {
        nameText = ""
        nameRequest = .add(scope)
    }

    private func startRenaming(_ category: CatalogCategory) {
        guard editMode == .inactive else { return }
        nameText = category.name
        nameRequest = .rename(category)
    }

    private func submitName(_ request: CategoryNameRequest) {
        let name = nameText.trimmed
        switch request {
        case .add(let scope):
            if let problem = CategoryEditing.nameProblem(name, in: scopeItems(scope)) {
                errorMessage = problem
                return
            }
            let body = CategoryCreateBody(section: section, serviceCategory: scope, name: name)
            perform {
                let created = try await api.createCategory(body)
                apply(CategoryEditing.upserting(created, in: categories.value ?? []))
                // A new product category is empty: open it, so items can be added right away.
                if opensItems { opened = created }
            }
        case .rename(let category):
            guard name != category.name else { return }
            if let problem = CategoryEditing.nameProblem(name, in: scopeItems(category.serviceCategory), excluding: category.id) {
                errorMessage = problem
                return
            }
            perform {
                let renamed = try await api.renameCategory(id: category.id, name: name)
                apply(CategoryEditing.upserting(renamed, in: categories.value ?? []))
            }
        }
    }

    private func move(_ scope: ServiceCategory?, from source: IndexSet, to destination: Int) {
        let reordered = CategoryEditing.reordered(scopeItems(scope), fromOffsets: source, toOffset: destination)
        let section = section
        apply(CategoryEditing.replacingScope(in: categories.value ?? [], section: section, serviceCategory: scope, with: reordered))
        perform {
            let saved = try await api.orderCategories(ids: reordered.map(\.id))
            apply(CategoryEditing.replacingScope(in: categories.value ?? [], section: section, serviceCategory: scope, with: saved))
        }
    }

    private func merge(_ source: CatalogCategory, into target: CatalogCategory) {
        perform {
            let merged = try await api.mergeCategory(id: source.id, into: target.id)
            let rest = (categories.value ?? []).filter { $0.id != source.id }
            apply(CategoryEditing.upserting(merged, in: rest))
        }
    }

    private func delete(_ category: CatalogCategory) {
        perform {
            try await api.deleteCategory(id: category.id)
            apply((categories.value ?? []).filter { $0.id != category.id })
        }
    }

    // MARK: - Name alert

    private var nameAlertBinding: Binding<Bool> {
        Binding(get: { nameRequest != nil }, set: { if !$0 { nameRequest = nil } })
    }

    private var nameAlertTitle: String {
        switch nameRequest {
        case .rename: "Переименовать"
        default: "Новая категория"
        }
    }

    private func isRename(_ request: CategoryNameRequest) -> Bool {
        if case .rename = request { return true }
        return false
    }

    private func nameAlertMessage(_ request: CategoryNameRequest) -> String {
        switch request {
        case .add(let scope):
            scope.map { "Категория раздела «\($0.title)»." } ?? "Категория раздела «\(section.title)»."
        case .rename(let category):
            category.itemCount > 0
                ? "Название сменится и у всего содержимого (\(CategoryEditing.countText(category.itemCount, section: section)))."
                : "В категории пока ничего нет."
        }
    }
}

extension CatalogSection {
    /// «украшений», «услуг», «расходников», «товаров» — for «Категории …».
    var genitiveTitle: String {
        switch self {
        case .jewelry: "украшений"
        case .service: "услуг"
        case .consumable: "расходников"
        case .goods: "товаров"
        }
    }
}

#if DEBUG
#Preview("Украшения") {
    CategoriesEditorView(section: .jewelry) {}
        .previewEnvironment()
}

#Preview("Услуги") {
    CategoriesEditorView(section: .service) {}
        .previewEnvironment()
}
#endif
