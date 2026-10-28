import SwiftUI

/// Multi-select service catalog pushed from the appointment editor: edits the draft's service lines in place.
struct ServicePickerView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(ReferenceStore.self) private var reference
    @Binding var draft: AppointmentDraft

    @State private var search = ""
    @State private var loadError: String?
    @State private var isLoading = true
    @State private var variantService: Service?
    @State private var showsCustom = false

    private var sections: [ServicePickerSection] {
        ServicePickerCatalog.sections(reference.activeServices, query: search)
    }

    var body: some View {
        List {
            if !draft.canAddLine {
                Section {
                    Label(
                        "В записи \(AppointmentDraft.maxLines) услуг — это максимум. Уберите услугу, чтобы добавить другую.",
                        systemImage: "exclamationmark.circle.fill"
                    )
                    .foregroundStyle(.orange)
                }
            }
            if search.nonEmpty == nil {
                Section {
                    Button {
                        showsCustom = true
                    } label: {
                        Label("Своя услуга", systemImage: "square.and.pencil")
                    }
                    .disabled(!draft.canAddLine)
                }
            }
            ForEach(sections) { section in
                Section(section.title) {
                    ForEach(section.services) { service in
                        Button {
                            tap(service)
                        } label: {
                            ServicePickerRow(
                                service: service,
                                masterId: draft.masterId,
                                count: draft.lineCount(serviceId: service.id),
                                selectedLine: draft.line(serviceId: service.id)
                            )
                        }
                        // Rows read as content, not as accent-colored buttons.
                        .tint(.primary)
                        // At the line cap only booked services stay tappable (to remove or switch a variant).
                        .disabled(!draft.canAddLine && draft.lineCount(serviceId: service.id) == 0)
                    }
                }
            }
        }
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Название, описание, группа")
        .overlay { overlay }
        .navigationTitle("Услуги")
        .navigationSubtitle(selectionSummary)
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
                Button("\(variant.name) — \(Money.format(service.price(for: draft.masterId, variant: variant)))") {
                    draft.select(service: service, variant: variant)
                }
            }
            if draft.lineCount(serviceId: service.id) > 0 {
                Button("Убрать", role: .destructive) { draft.removeLines(serviceId: service.id) }
            }
            Button("Отмена", role: .cancel) {}
        } message: { service in
            if let line = draft.line(serviceId: service.id) {
                Text("Сейчас в записи: \(line.name)")
            }
        }
        .sheet(isPresented: $showsCustom) {
            CustomServiceSheet { name, price in draft.addCustom(name: name, price: price) }
        }
        .sensoryFeedback(.selection, trigger: draft.lines.count)
        .task { await load() }
    }

    @ViewBuilder
    private var overlay: some View {
        if let loadError {
            ErrorStateView(message: loadError) { await load() }
        } else if isLoading && reference.services.isEmpty {
            ProgressView()
        } else if reference.activeServices.isEmpty {
            ContentUnavailableView {
                Label("Нет услуг", systemImage: "list.bullet.rectangle")
            } description: {
                Text("Добавьте услуги в разделе «Склад → Услуги» или впишите свою услугу для этой записи.")
            } actions: {
                Button("Своя услуга") { showsCustom = true }
                    .buttonStyle(.glassProminent)
                    .disabled(!draft.canAddLine)
            }
        } else if sections.isEmpty {
            ContentUnavailableView.search(text: search)
        }
    }

    /// «Выбрано: 2 · 4 100 ₽».
    private var selectionSummary: String {
        guard !draft.lines.isEmpty else { return "" }
        return "Выбрано: \(draft.lines.count) · \(Money.format(draft.total))"
    }

    private var variantDialogBinding: Binding<Bool> {
        Binding(get: { variantService != nil }, set: { if !$0 { variantService = nil } })
    }

    private func tap(_ service: Service) {
        if !service.variants.isEmpty {
            variantService = service
        } else {
            draft.toggle(service: service)
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

private struct ServicePickerRow: View {
    let service: Service
    /// The appointment's master: the row shows their price.
    let masterId: Int?
    let count: Int
    let selectedLine: DraftServiceLine?

    private var isSelected: Bool { count > 0 }

    var body: some View {
        HStack(spacing: 12) {
            ServiceThumbnail(service: service, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(service.name).foregroundStyle(.primary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                if !service.variants.isEmpty, let selectedLine {
                    Text(selectedLine.name)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Color.accentColor)
                }
            }
            Spacer(minLength: 8)
            if count > 1 {
                Text("×\(count)")
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(Color.accentColor)
            }
            if isSelected {
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
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    /// «от 2 000 до 5 000 ₽ · 1 ч» (the master's price), with the variant count for services with options.
    private var subtitle: String {
        var parts = [service.priceText(for: masterId), DateText.duration(minutes: service.durationMin)]
        if !service.variants.isEmpty {
            parts.append(Plural.count(service.variants.count, one: "вариант", few: "варианта", many: "вариантов"))
        }
        return parts.joined(separator: " · ")
    }
}

/// Free-form service line: name and price.
private struct CustomServiceSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onAdd: (String, Int) -> Void

    @State private var name = ""
    @State private var price = 0
    @FocusState private var focusesName: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Название", text: $name)
                        .focused($focusesName)
                        .submitLabel(.done)
                    NumberField.money("Цена", value: $price)
                } footer: {
                    Text("Например, подбор украшения или замена серьги. Услуга добавится только в эту запись.")
                }
            }
            .navigationTitle("Своя услуга")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Добавить") {
                        onAdd(name, price)
                        dismiss()
                    }
                    .disabled(name.nonEmpty == nil)
                }
            }
            .onAppear { focusesName = true }
        }
        .presentationDetents([.medium])
    }
}

/// A catalog section: category, or «category · group» when the category is split into groups.
nonisolated struct ServicePickerSection: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let services: [Service]
}

nonisolated enum ServicePickerCatalog {
    /// Section of services without a group (`Service.groupTitle`); a group literally named so is merged into it.
    static let ungroupedTitle = "Другое"

    /// Services matching `query`, sectioned by category, then group (in catalog order; ungrouped last).
    static func sections(_ services: [Service], query: String) -> [ServicePickerSection] {
        let matching = services.filter { matches($0, query: query) }
        return ServiceCategory.allCases.flatMap { category in
            sections(of: category, in: matching.filter { $0.category == category })
        }
    }

    /// Case- and diacritic-insensitive search over name, description, group and variant names.
    static func matches(_ service: Service, query: String) -> Bool {
        guard let query = query.nonEmpty else { return true }
        let fields: [String?] = [service.name, service.description, service.group] + service.variants.map { $0.name as String? }
        return fields.contains { $0?.localizedStandardContains(query) == true }
    }

    private static func sections(of category: ServiceCategory, in services: [Service]) -> [ServicePickerSection] {
        guard !services.isEmpty else { return [] }
        let titles = orderedGroupTitles(services)
        guard titles.contains(where: { $0 != ungroupedTitle }) else {
            return [ServicePickerSection(id: category.rawValue, title: category.title, services: services)]
        }
        return titles.map { title in
            ServicePickerSection(
                id: "\(category.rawValue)/\(title)",
                title: title == category.title ? title : "\(category.title) · \(title)",
                services: services.filter { $0.groupTitle == title }
            )
        }
    }

    /// Distinct group titles (unique, so section ids are too) in order of first appearance; ungrouped last.
    private static func orderedGroupTitles(_ services: [Service]) -> [String] {
        let unique = services.map(\.groupTitle).reduce(into: [String]()) { titles, title in
            if !titles.contains(title) { titles.append(title) }
        }
        return unique.filter { $0 != ungroupedTitle } + unique.filter { $0 == ungroupedTitle }
    }
}

#if DEBUG
#Preview {
    @Previewable @State var draft = AppointmentDraft.new(day: .now)
    NavigationStack {
        ServicePickerView(draft: $draft)
    }
    .previewEnvironment()
}
#endif
