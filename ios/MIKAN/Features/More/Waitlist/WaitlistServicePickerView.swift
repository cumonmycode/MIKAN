import SwiftUI

/// Catalog multi-select for a waitlist entry: up to 5 active services, one each; a service with variants asks which.
struct WaitlistServicePickerView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(ReferenceStore.self) private var reference
    @Binding var draft: WaitlistDraft

    @State private var search = ""
    @State private var loadError: String?
    @State private var isLoading = true
    @State private var variantService: Service?

    private var sections: [ServicePickerSection] {
        ServicePickerCatalog.sections(reference.activeServices, query: search)
    }

    var body: some View {
        List {
            if !draft.canAddItem {
                Section {
                    Label(
                        "Выбрано \(WaitlistDraft.maxItems) услуг — это максимум. Уберите услугу, чтобы выбрать другую.",
                        systemImage: "exclamationmark.circle.fill"
                    )
                    .foregroundStyle(.orange)
                }
            }
            ForEach(sections) { section in
                Section(section.title) {
                    ForEach(section.services) { service in
                        let item = draft.item(serviceId: service.id)
                        Button {
                            tap(service)
                        } label: {
                            WaitlistServiceRow(service: service, selected: item)
                        }
                        .tint(.primary)
                        // At the cap only chosen services stay tappable (to remove or switch a variant).
                        .disabled(!draft.canAddItem && item == nil)
                    }
                }
            }
        }
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Название, описание, группа")
        .overlay { overlay }
        .navigationTitle("Услуги")
        .navigationSubtitle(draft.items.isEmpty ? "" : "Выбрано: \(draft.items.count) из \(WaitlistDraft.maxItems)")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Готово") { dismiss() }
            }
        }
        .confirmationDialog(
            variantService?.name ?? "",
            isPresented: variantDialogBinding,
            titleVisibility: .visible,
            presenting: variantService
        ) { service in
            ForEach(service.variants, id: \.self) { variant in
                Button(variant.name) { draft.select(service: service, variant: variant) }
            }
            if draft.item(serviceId: service.id) != nil {
                Button("Убрать", role: .destructive) { draft.remove(serviceId: service.id) }
            }
            Button("Отмена", role: .cancel) {}
        } message: { service in
            if let item = draft.item(serviceId: service.id) {
                Text("Сейчас выбрано: \(item.title)")
            }
        }
        .sensoryFeedback(.selection, trigger: draft.items.count)
        .task { await load() }
    }

    @ViewBuilder
    private var overlay: some View {
        if let loadError {
            ErrorStateView(message: loadError) { await load() }
        } else if isLoading && reference.services.isEmpty {
            ProgressView()
        } else if reference.activeServices.isEmpty {
            ContentUnavailableView(
                "Нет услуг",
                systemImage: "list.bullet.rectangle",
                description: Text("Добавьте услуги в разделе «Склад → Услуги».")
            )
        } else if sections.isEmpty {
            ContentUnavailableView.search(text: search)
        }
    }

    private var variantDialogBinding: Binding<Bool> {
        Binding(get: { variantService != nil }, set: { if !$0 { variantService = nil } })
    }

    private func tap(_ service: Service) {
        if service.variants.isEmpty {
            draft.toggle(service: service)
        } else {
            variantService = service
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            try await reference.ensureServices()
            loadError = nil
        } catch {
            loadError = error.userMessage
        }
    }
}

private struct WaitlistServiceRow: View {
    let service: Service
    let selected: WaitlistDraftItem?

    var body: some View {
        HStack(spacing: 12) {
            ServiceThumbnail(service: service, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(service.name).foregroundStyle(.primary)
                if !service.variants.isEmpty {
                    Text(selected?.variant ?? Plural.count(service.variants.count, one: "вариант", few: "варианта", many: "вариантов"))
                        .font(.caption.weight(selected == nil ? .regular : .medium))
                        .foregroundStyle(selected == nil ? Color.secondary : Color.accentColor)
                }
            }
            Spacer(minLength: 8)
            if selected != nil {
                Image(systemName: "checkmark")
                    .foregroundStyle(Color.accentColor)
                    .fontWeight(.semibold)
            } else if !service.variants.isEmpty {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected != nil ? .isSelected : [])
    }
}

#if DEBUG
#Preview {
    @Previewable @State var draft = WaitlistDraft()
    NavigationStack {
        WaitlistServicePickerView(draft: $draft)
    }
    .previewEnvironment()
}
#endif
