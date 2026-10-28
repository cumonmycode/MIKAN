import SwiftUI

/// The services of the warehouse: by category, then by group in the warehouse categories' order, «Без группы» last.
/// Works as a tab root or pushed inside another `NavigationStack` (the warehouse).
struct ServicesListView: View {
    @Environment(APIClient.self) private var api
    @Environment(ReferenceStore.self) private var reference
    @Environment(\.permissions) private var permissions
    @State private var services = Remote<[Service]>()
    @State private var search = ""
    @State private var showsNewEditor = false
    /// The opened service card. Navigation goes through this id (not a row link), so re-sectioning
    /// the list after an edit (another group or category) does not pop the card.
    @State private var openedServiceID: Int?

    private var allServices: [Service] { services.value ?? [] }
    private var sections: [ServiceCatalogSection] {
        ServiceCatalog.sections(ServiceCatalog.filter(allServices, query: search), categories: reference.categories)
    }

    var body: some View {
        List {
            ForEach(sections) { section in
                Section {
                    ForEach(section.services) { service in
                        Button {
                            openedServiceID = service.id
                        } label: {
                            ServiceRow(service: service)
                        }
                        // Rows read as content, not as accent-colored buttons.
                        .tint(.primary)
                    }
                } header: {
                    ServiceSectionHeader(section: section)
                }
            }
        }
        .auraBackground()
        .searchable(text: $search, prompt: "Название, группа, описание")
        .overlay {
            RemoteStateOverlay(remote: services, isEmpty: { _ in sections.isEmpty }, retry: load) {
                emptyState
            }
        }
        .refreshable {
            await load()
            await loadCategories(force: true)
        }
        .task { await load() }
        .task { await loadCategories(force: false) }
        .remoteErrorAlert(services)
        .navigationTitle("Услуги")
        .toolbar {
            if permissions.editsCatalog {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Новая услуга", systemImage: "plus") { showsNewEditor = true }
                        // New services are merged into the loaded catalog; without it there is nothing to merge into.
                        .disabled(services.value == nil)
                }
            }
        }
        .navigationDestination(item: $openedServiceID) { id in
            if let service = allServices.first(where: { $0.id == id }) {
                ServiceDetailView(service: service, groupSuggestions: groupSuggestions) { apply($0) }
            }
        }
        .sheet(isPresented: $showsNewEditor) {
            ServiceEditorView(
                service: nil,
                nextSort: ServiceCatalog.nextSort(after: allServices),
                groupSuggestions: groupSuggestions
            ) { saved in
                apply(saved)
            }
        }
    }

    private var groupSuggestions: [ServiceCategory: [String]] {
        ServiceCatalog.groupSuggestions(allServices)
    }

    @ViewBuilder
    private var emptyState: some View {
        if allServices.isEmpty {
            ContentUnavailableView {
                Label("Услуг пока нет", systemImage: "list.bullet.rectangle")
            } description: {
                Text("Добавьте услуги с ценами и длительностью — они нужны для записи, кассы и ответов бота.")
            } actions: {
                if permissions.editsCatalog {
                    Button("Добавить услугу") { showsNewEditor = true }
                        .buttonStyle(.glassProminent)
                }
            }
        } else {
            ContentUnavailableView.search(text: search)
        }
    }

    private func load() async {
        await services.load { ServiceCatalog.sorted(try await api.services(includeInactive: true)) }
        if let value = services.value { reference.replaceServices(value) }
    }

    /// Only orders the groups; without the registry they follow alphabetically, so a failure is not shown.
    private func loadCategories(force: Bool) async {
        try? await reference.ensureCategories(force: force)
    }

    /// Merges a created or edited service into the loaded catalog. Never publishes a partial catalog:
    /// without a loaded list it reloads instead.
    private func apply(_ service: Service) {
        guard let current = services.value else {
            Task { await load() }
            return
        }
        let updated = ServiceCatalog.upserting(service, into: current)
        services.set(updated)
        reference.replaceServices(updated)
    }
}

/// Category title above its first group, then the group name.
private struct ServiceSectionHeader: View {
    let section: ServiceCatalogSection

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if section.isFirstInCategory {
                Label(section.category.title, systemImage: section.category.symbol)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(.primary)
                    .textCase(nil)
            }
            // «Тату → Тату» would repeat the category title.
            if let group = section.group, group != section.category.title {
                Text(group)
            }
        }
        .padding(.top, section.isFirstInCategory ? 8 : 0)
        .accessibilityAddTraits(.isHeader)
    }
}

private struct ServiceRow: View {
    let service: Service

    private static let thumbnailSize: CGFloat = 52

    var body: some View {
        HStack(spacing: 12) {
            ServiceThumbnail(service: service, size: Self.thumbnailSize)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(service.name)
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    if !service.active {
                        StatusBadge(text: "Скрыта", color: .gray)
                    }
                }
                Text(service.priceText)
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.primary)
                Text(details)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.forward")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .contentShape(.rect)
        .opacity(service.active ? 1 : 0.6)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Открыть карточку услуги")
    }

    private var details: String {
        var parts = [DateText.duration(minutes: service.durationMin)]
        if !service.variants.isEmpty {
            parts.append(Plural.count(service.variants.count, one: "вариант", few: "варианта", many: "вариантов"))
        }
        if !service.masterPrices.isEmpty {
            parts.append("у мастеров свои цены")
        }
        if service.requiresDeposit {
            parts.append("предоплата \(Money.format(service.depositAmount))")
        }
        if !service.jewelryIds.isEmpty {
            parts.append(Plural.count(service.jewelryIds.count, one: "украшение", few: "украшения", many: "украшений"))
        }
        return parts.joined(separator: " · ")
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        ServicesListView()
    }
    .previewEnvironment()
}
#endif
