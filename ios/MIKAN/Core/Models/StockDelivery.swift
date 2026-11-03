import Foundation

/// One line of a delivery: a `receipt` movement of one size.
nonisolated struct StockDeliveryLine: Codable, Hashable, Sendable {
    let movementId: Int
    let productId: Int
    let productName: String
    let productKind: ProductKind
    let variantId: Int
    /// Current name of the size ("" for a product without sizes).
    let variantName: String
    let quantity: Int
    /// `nil` — received without a cost.
    let unitCost: Int?
    let amount: Int?

    /// «Лабрет — 8 мм», or just the product name without a size.
    var displayName: String {
        guard let size = variantName.nonEmpty else { return productName }
        return "\(productName) — \(size)"
    }
}

/// A delivery (поставка): one receiving of many products and sizes from a supplier (docs/API.md «StockDelivery»).
nonisolated struct StockDelivery: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let number: Int
    let supplier: String?
    let note: String?
    /// Σ amounts of the lines with a cost.
    let total: Int
    /// Σ quantities.
    let itemCount: Int
    let lineCount: Int
    let employee: EmployeeRef?
    let createdAt: Date
    /// In the order received; `[]` in lists.
    let lines: [StockDeliveryLine]
}

/// A supplier for the picker (`GET /stock/suppliers`), most recently used first.
nonisolated struct StockSupplier: Codable, Hashable, Identifiable, Sendable {
    let name: String
    let deliveries: Int
    /// The latest delivery; `nil` when only products name the supplier.
    let lastAt: Date?

    var id: String { name }
}
