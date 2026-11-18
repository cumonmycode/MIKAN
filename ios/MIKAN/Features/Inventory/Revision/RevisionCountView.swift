import SwiftUI

/// Counting one section: every size starts at its expected stock; the employee fixes what differs, ticks what matches,
/// marks the availability of «есть / нет» consumables, and records the count (`POST /stock/revisions`).
struct RevisionCountView: View {
    @Environment(APIClient.self) private var api
    @Environment(ReferenceStore.self) private var reference
    let section: CatalogSection
    let onPosted: (StockRevision) -> Void
    let onCancel: () -> Void

    @State private var products = Remote<[Product]>()
    @State private var draft: RevisionDraft?
    @State private var search = ""
    @State private var lineFilter: RevisionLineFilter = .all
    @FocusState private var focusedSize: Int?
    @State private var confirmsSubmit = false
    @State private var confirmsCancel = false
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var retryMessage: String?
    @State private var revisionKey = IdempotencyKey()

    init(section: CatalogSection, onPosted: @escaping (StockRevision) -> Void, onCancel: @escaping () -> Void) {
        self.section = section
        self.onPosted = onPosted
        self.onCancel = onCancel
    }

    private var hasProgress: Bool { (draft?.checkedCount ?? 0) > 0 || !(draft?.note.trimmed.isEmpty ?? true) }

    var body: some View {
        Group {
            if let draft {
                countList(draft)
            } else {
                Color.clear
                    .overlay { RemoteStateOverlay(remote: products, retry: load) }
            }
        }
        .background { AuraBackground() }
        .navigationTitle("Ревизия · \(section.title)")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden()
        .toolbar { toolbar }
        .interactiveDismissDisabled(hasProgress || isSaving)
        .task {
            guard draft == nil else { return }
            await load()
        }
        .confirmationDialog("Прервать ревизию?", isPresented: $confirmsCancel, titleVisibility: .visible) {
            Button("Прервать", role: .destructive, action: onCancel)
            Button("Продолжить", role: .cancel) {}
        } message: {
            Text("Подсчёт не сохранится.")
        }
        .confirmationDialog(submitTitle, isPresented: $confirmsSubmit, titleVisibility: .visible) {
            Button("Остальное сходится — провести") {
                self.draft = draft?.confirmingUnchecked()
                submit()
            }
            if (draft?.checkedCount ?? 0) > 0 {
                Button("Провести только проверенное", action: submit)
            }
            Button("Вернуться к подсчёту", role: .cancel) {}
        } message: {
            Text("Непроверенные позиции можно считать сходящимися с остатком или не включать в ревизию.")
        }
        .errorAlert($errorMessage)
        .retryAlert($retryMessage, title: "Ревизия могла пройти", retry: submit)
    }

    // MARK: - List

    private func countList(_ draft: RevisionDraft) -> some View {
        let groups = draft.visibleGroups(search: search, filter: lineFilter)
        return List {
            ForEach(groups) { group in
                Section {
                    ForEach(group.items) { product in
                        RevisionProductRows(product: product, draft: draftBinding, focus: $focusedSize)
                    }
                } header: {
                    RevisionGroupHeader(
                        title: group.title,
                        unchecked: draft.uncheckedCount(inGroup: group.id)
                    ) {
                        withAnimation(.snappy) { self.draft = draft.confirmingUnchecked(inGroup: group.id) }
                    }
                }
            }
            if lineFilter == .all && search.trimmed.isEmpty {
                Section("Комментарий") {
                    TextField("Например, «Конец месяца»", text: noteBinding, axis: .vertical)
                        .lineLimit(1...4)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        // Always shown: an auto-hiding drawer above the pinned filter made the list jump at the top.
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Название, размер")
        .safeAreaBar(edge: .top) {
            Picker("Показать", selection: $lineFilter.animation(.snappy)) {
                ForEach(RevisionLineFilter.allCases) { filter in
                    Text(filterTitle(filter, draft: draft)).tag(filter)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .safeAreaInset(edge: .bottom) {
            RevisionSummaryBar(draft: draft, isSaving: isSaving, onConfirmRest: {
                withAnimation(.snappy) { self.draft = draft.confirmingUnchecked() }
            }, onSubmit: requestSubmit)
        }
        .overlay {
            if groups.isEmpty {
                emptyState(draft)
            }
        }
    }

    @ViewBuilder
    private func emptyState(_ draft: RevisionDraft) -> some View {
        if draft.isEmpty {
            ContentUnavailableView(
                "Нечего пересчитывать",
                systemImage: section.symbol,
                description: Text("В разделе «\(section.title)» пока нет позиций.")
            )
        } else if !search.trimmed.isEmpty {
            ContentUnavailableView.search(text: search)
        } else {
            ContentUnavailableView(
                lineFilter == .changed ? "Расхождений нет" : "Всё проверено",
                systemImage: "checkmark.seal",
                description: Text(lineFilter == .changed ? "Отмеченные позиции сходятся с остатками." : "Можно проводить ревизию.")
            )
        }
    }

    private func filterTitle(_ filter: RevisionLineFilter, draft: RevisionDraft) -> String {
        switch filter {
        case .all: filter.title
        case .unchecked: draft.uncheckedCount > 0 ? "\(filter.title) · \(draft.uncheckedCount)" : filter.title
        case .changed: draft.changedCount > 0 ? "\(filter.title) · \(draft.changedCount)" : filter.title
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Отмена", role: .cancel) {
                if hasProgress { confirmsCancel = true } else { onCancel() }
            }
            .disabled(isSaving)
        }
        ToolbarItemGroup(placement: .keyboard) {
            Button("Предыдущий", systemImage: "chevron.up") { moveFocus(by: -1) }
                .disabled(!canMoveFocus(by: -1))
            Button("Следующий", systemImage: "chevron.down") { moveFocus(by: 1) }
                .disabled(!canMoveFocus(by: 1))
            Spacer()
            Button("Готово") { focusedSize = nil }
                .fontWeight(.semibold)
        }
    }

    // MARK: - Bindings

    private var draftBinding: Binding<RevisionDraft> {
        Binding(get: { draft ?? RevisionDraft(section: section, products: [], categories: []) }, set: { draft = $0 })
    }

    private var noteBinding: Binding<String> {
        Binding(get: { draft?.note ?? "" }, set: { draft?.note = $0 })
    }

    // MARK: - Keyboard

    /// Count fields in screen order.
    private var focusOrder: [Int] {
        guard let draft else { return [] }
        return draft.visibleGroups(search: search, filter: lineFilter).flatMap { $0.items.flatMap(\.sizes).map(\.id) }
    }

    private func canMoveFocus(by step: Int) -> Bool {
        guard let focusedSize, let index = focusOrder.firstIndex(of: focusedSize) else { return false }
        return focusOrder.indices.contains(index + step)
    }

    private func moveFocus(by step: Int) {
        let order = focusOrder
        guard let focusedSize, let index = order.firstIndex(of: focusedSize), order.indices.contains(index + step) else { return }
        self.focusedSize = order[index + step]
    }

    // MARK: - Data

    private func load() async {
        let kind = section.productKind ?? .jewelry
        try? await reference.ensureCategories()
        await products.load { try await api.products(kind: kind, includeInactive: true) }
        if draft == nil, let items = products.value {
            draft = RevisionDraft(section: section, products: items, categories: reference.categories)
        }
    }

    private var submitTitle: String {
        guard let draft else { return "" }
        return "Не проверено: " + Plural.count(draft.uncheckedCount, one: "позиция", few: "позиции", many: "позиций")
    }

    private func requestSubmit() {
        focusedSize = nil
        guard let draft else { return }
        if draft.uncheckedCount > 0 {
            confirmsSubmit = true
        } else {
            submit()
        }
    }

    private func submit() {
        guard let draft, draft.canSubmit, !isSaving else { return }
        let body = draft.body
        let key = revisionKey.key(for: body)
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let revision = try await api.createRevision(body, idempotencyKey: key)
                revisionKey.reset()
                onPosted(revision)
            } catch let error as APIError where error.isOutcomeUnknown {
                retryMessage = "Связь прервалась до ответа сервера. Нажмите «Повторить» — если ревизия уже прошла, второй раз она не проведётся."
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

/// Category title with «Сходится» for its unchecked lines.
private struct RevisionGroupHeader: View {
    let title: String
    let unchecked: Int
    let onConfirm: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            if unchecked > 0 {
                Button("Всё сходится · \(unchecked)", systemImage: "checkmark.circle", action: onConfirm)
                    .font(.footnote.weight(.semibold))
                    .textCase(nil)
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Отметить сходящимися: \(unchecked)")
            }
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        RevisionCountView(section: .consumable) { _ in } onCancel: {}
    }
    .previewEnvironment()
}
#endif
