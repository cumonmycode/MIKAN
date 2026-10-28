import SwiftUI

/// A category picked from the section's categories (in staff order), «Без категории», or a new name typed in place.
/// With a `scope` the new category is created on the server at once, so every picker in the app offers it; without
/// one (or offline) the server creates it when the item is saved.
struct CategoryField: View {
    @Environment(APIClient.self) private var api
    @Environment(ReferenceStore.self) private var reference

    var title = "Категория"
    /// Where a new category is created at once; `nil` — only when the item is saved.
    var scope: CategoryScope?
    /// Category names in staff order.
    let options: [String]
    /// "" — no category.
    @Binding var selection: String

    @State private var showsNewName = false
    @State private var newName = ""
    @State private var isCreating = false

    var body: some View {
        Menu {
            Button {
                selection = ""
            } label: {
                choiceLabel("Без категории", isSelected: selection.trimmed.isEmpty)
            }
            ForEach(options, id: \.self) { name in
                Button {
                    selection = name
                } label: {
                    choiceLabel(name, isSelected: name == selection)
                }
            }
            Divider()
            Button("Новая категория…", systemImage: "plus") {
                newName = ""
                showsNewName = true
            }
        } label: {
            LabeledContent(title) {
                HStack(spacing: 6) {
                    if isCreating {
                        ProgressView().controlSize(.small)
                    }
                    Text(selection.nonEmpty ?? "Без категории")
                        .foregroundStyle(selection.nonEmpty == nil ? .secondary : .primary)
                }
            }
            .contentShape(.rect)
        }
        .foregroundStyle(.primary)
        .disabled(isCreating)
        .alert("Новая категория", isPresented: $showsNewName) {
            TextField("Название", text: $newName)
            Button("Добавить") { add(newName) }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text(scope == nil
                ? "Категория появится, когда вы сохраните карточку."
                : "Категория сразу появится в списке — её можно будет выбрать и для других позиций.")
        }
    }

    @ViewBuilder
    private func choiceLabel(_ text: String, isSelected: Bool) -> some View {
        if isSelected {
            Label(text, systemImage: "checkmark")
        } else {
            Text(text)
        }
    }

    /// Picks the category already called so (in any case), or the new name — created on the server when there is a scope.
    private func add(_ typed: String) {
        guard let name = typed.nonEmpty else { return }
        let key = InventoryFilter.normalized(name)
        if let existing = options.first(where: { InventoryFilter.normalized($0) == key }) {
            selection = existing
            return
        }
        selection = name
        if let scope { create(name, in: scope) }
    }

    private func create(_ name: String, in scope: CategoryScope) {
        isCreating = true
        Task {
            defer { isCreating = false }
            let body = CategoryCreateBody(section: scope.section, serviceCategory: scope.serviceCategory, name: name)
            do {
                let created = try await api.createCategory(body)
                reference.upsertCategory(created)
                if selection == name { selection = created.name }
            } catch {
                // Made on another phone meanwhile (409) or offline: the name stays picked and the server registers it
                // when the item is saved. A fresh registry brings the stored spelling when there is one.
                try? await reference.ensureCategories(force: true)
                if selection == name, let stored = reference.categories.named(name, in: scope) {
                    selection = stored.name
                }
            }
        }
    }
}
