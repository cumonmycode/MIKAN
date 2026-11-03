import Foundation

/// The segments of the catalog over a receipt: the warehouse sections that are sold.
nonisolated enum POSCatalog: String, CaseIterable, Identifiable, Sendable {
    case jewelry
    case services
    case goods

    /// `@AppStorage` key of the segment last used: the catalog opens on it again.
    static let storageKey = "pos.catalogSegment"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .jewelry: "Украшения"
        case .services: "Услуги"
        case .goods: "Товары"
        }
    }

    var searchPrompt: String {
        switch self {
        case .jewelry: "Поиск украшений"
        case .services: "Поиск услуг"
        case .goods: "Поиск товаров"
        }
    }
}

/// Filtering, grouping and hints of the service catalog (pure, no UI state).
nonisolated enum POSServiceCatalog {
    /// Title of the ungrouped rest of a category that has named groups; that section goes last.
    static let ungroupedTitle = "Другое"

    /// One block of the catalog: a group of one category.
    struct GridSection: Identifiable, Equatable, Sendable {
        let category: ServiceCategory
        /// Group title («Другое» for the ungrouped rest); `nil` when the category has no named groups.
        let group: String?
        let isFirstInCategory: Bool
        let services: [Service]

        var id: String { "\(category.rawValue)|\(group ?? "")" }

        /// Header lines. The category title opens each category when several are shown; the group title
        /// follows unless it just repeats that category title (group «Тату» inside «Тату»).
        func headers(showsCategories: Bool) -> (category: String?, group: String?) {
            let categoryTitle = showsCategories && isFirstInCategory ? category.title : nil
            let groupTitle = categoryTitle != nil && group == category.title ? nil : group
            return (categoryTitle, groupTitle)
        }
    }

    /// Categories that have at least one of `services`, in the standard order.
    static func categories(of services: [Service]) -> [ServiceCategory] {
        ServiceCategory.allCases.filter { category in services.contains { $0.category == category } }
    }

    /// Services of `category` (all when `nil`) whose name, group, description or variants match `query`.
    static func filter(_ services: [Service], category: ServiceCategory?, query: String) -> [Service] {
        let needle = query.trimmed.lowercased()
        return services.filter { service in
            guard category == nil || service.category == category else { return false }
            guard !needle.isEmpty else { return true }
            let haystack = ([service.name, service.group, service.description] + service.variants.map(\.name))
                .compactMap { $0?.lowercased() }
                .joined(separator: " ")
            return haystack.contains(needle)
        }
    }

    /// Sections by category (tattoo, piercing, other), then by group in catalog order (`sort`, name);
    /// the ungrouped rest of a category goes last as «Другое» — the same order as the services list.
    static func sections(_ services: [Service]) -> [GridSection] {
        let ordered = services.sorted { ($0.sort, $0.name, $0.id) < ($1.sort, $1.name, $1.id) }
        return ServiceCategory.allCases.flatMap { category in
            sections(of: category, ordered.filter { $0.category == category })
        }
    }

    private static func sections(of category: ServiceCategory, _ items: [Service]) -> [GridSection] {
        let hasNamedGroups = items.contains { $0.group.nonEmpty != nil }
        let firstSeen = items.map(\.groupTitle).reduce(into: [String]()) { titles, title in
            if !titles.contains(title) { titles.append(title) }
        }
        let titles = firstSeen.filter { $0 != ungroupedTitle } + firstSeen.filter { $0 == ungroupedTitle }
        return titles.enumerated().map { index, title in
            GridSection(
                category: category,
                group: hasNamedGroups ? title : nil,
                isFirstInCategory: index == 0,
                services: items.filter { $0.groupTitle == title }
            )
        }
    }

    /// Shown after adding a service whose final price is set per visit (for `masterId`, their own range counts).
    static func priceHint(for service: Service, variant: ServiceVariant?, masterId: Int? = nil) -> String? {
        guard variant == nil else { return nil }
        let ownRange = service.masterPrice(for: masterId)?.priceMax != nil
        guard service.hasVariablePrice || ownRange else { return nil }
        return "Добавлено по \(Money.format(service.price(for: masterId))) — итоговую цену можно изменить в чеке"
    }
}
