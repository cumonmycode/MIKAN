import Foundation

/// The four sections of the warehouse. Product sections are product kinds.
nonisolated enum CatalogSection: String, Codable, CaseIterable, Identifiable, Sendable {
    case jewelry
    case service
    case consumable
    case goods

    var id: String { rawValue }

    var title: String {
        switch self {
        case .jewelry: "Украшения"
        case .service: "Услуги"
        case .consumable: "Расходники"
        case .goods: "Товары"
        }
    }

    var symbol: String {
        switch self {
        case .jewelry: "sparkles"
        case .service: "list.bullet.rectangle"
        case .consumable: "shippingbox"
        case .goods: "bag"
        }
    }

    /// The product kind this section lists; `nil` for services.
    var productKind: ProductKind? {
        switch self {
        case .jewelry: .jewelry
        case .consumable: .consumable
        case .goods: .goods
        case .service: nil
        }
    }

    init(kind: ProductKind) {
        switch kind {
        case .jewelry: self = .jewelry
        case .consumable: self = .consumable
        case .goods: self = .goods
        }
    }
}

/// A category of a warehouse section, in staff order. Items link to it by name
/// (`Product.category`, `Service.group` within its `ServiceCategory`).
nonisolated struct CatalogCategory: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let section: CatalogSection
    /// Set for the `service` section only.
    let serviceCategory: ServiceCategory?
    var name: String
    var position: Int
    var itemCount: Int
}

/// Where categories live: a warehouse section and, in «Услуги», one service category.
nonisolated struct CategoryScope: Hashable, Sendable {
    let section: CatalogSection
    var serviceCategory: ServiceCategory? = nil
}

nonisolated extension Array where Element == CatalogCategory {
    /// The registered category of the scope with this name (trimmed, case- and «ё»-insensitive).
    func named(_ name: String, in scope: CategoryScope) -> CatalogCategory? {
        let key = InventoryFilter.normalized(name)
        guard !key.isEmpty else { return nil }
        return self.scope(scope.section, serviceCategory: scope.serviceCategory)
            .first { InventoryFilter.normalized($0.name) == key }
    }

    /// Categories of one section (and service category), in staff order.
    func scope(_ section: CatalogSection, serviceCategory: ServiceCategory? = nil) -> [CatalogCategory] {
        filter { $0.section == section && $0.serviceCategory == serviceCategory }.sorted { $0.position < $1.position }
    }

    /// Category names in staff order, then names items carry that are not registered yet (alphabetically).
    func orderedNames(_ section: CatalogSection, serviceCategory: ServiceCategory? = nil, including extra: [String] = []) -> [String] {
        let registered = scope(section, serviceCategory: serviceCategory).map(\.name)
        let known = Set(registered)
        let unknown = Set(extra.compactMap(\.nonEmpty)).subtracting(known).sorted()
        return registered + unknown
    }
}

/// How a consumable is tracked.
nonisolated enum StockMode: String, Codable, CaseIterable, Identifiable, Sendable {
    /// Counted in units, like everything else.
    case quantity
    /// Only «есть / заканчивается / нет».
    case presence

    var id: String { rawValue }

    var title: String {
        switch self {
        case .quantity: "Считать количество"
        case .presence: "Только «есть / нет»"
        }
    }
}

/// The marked availability of a presence consumable.
nonisolated enum PresenceStatus: String, Codable, CaseIterable, Identifiable, Sendable {
    case ok
    case low
    case out

    var id: String { rawValue }

    var title: String {
        switch self {
        case .ok: "Есть"
        case .low: "Заканчивается"
        case .out: "Нет"
        }
    }
}

/// The consumption norm of one procedure of a service.
nonisolated struct ServiceConsumable: Codable, Hashable, Sendable {
    var productId: Int
    var quantity: Int
}

/// One stock count (ревизия).
nonisolated struct StockRevision: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let number: Int
    /// The section counted; `nil` for a mixed count.
    let section: CatalogSection?
    let note: String?
    let employee: EmployeeRef?
    /// Lines checked and of them those that differed.
    let counted: Int
    let changed: Int
    let surplus: Int
    let shortage: Int
    let surplusCost: Int
    let shortageCost: Int
    let presenceChanges: [PresenceChange]
    /// Only in the detail and the create response; `[]` in lists.
    let movements: [StockMovement]
    let createdAt: Date

    nonisolated struct PresenceChange: Codable, Hashable, Sendable {
        let productId: Int
        let productName: String
        let from: PresenceStatus
        let to: PresenceStatus
    }
}

/// What completing an appointment took from the stock.
nonisolated struct Consumption: Codable, Hashable, Sendable {
    var used: [Used] = []
    var shortages: [Shortage] = []

    nonisolated struct Used: Codable, Hashable, Sendable {
        let productId: Int
        let productName: String
        let quantity: Int
    }

    nonisolated struct Shortage: Codable, Hashable, Sendable {
        let productId: Int
        let productName: String
        let needed: Int
        let deducted: Int
    }
}
