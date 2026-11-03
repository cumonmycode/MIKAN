import Foundation

nonisolated enum MovementType: String, Codable, CaseIterable, Identifiable, Sendable {
    case receipt
    case sale
    case returned = "return"
    case writeoff
    case usage
    case adjustment
    /// A restock of a presence consumable, recorded with what it cost (no quantity moves).
    case purchase
    /// A type this build does not know yet (sent by a newer server); never sent by the app.
    case other

    var id: String { rawValue }

    /// Movement types an employee can create manually.
    static let manual: [MovementType] = [.receipt, .writeoff, .usage, .adjustment]
    /// Types the movements list filters by.
    static let listed: [MovementType] = allCases.filter { $0 != .other }

    /// The manual operations of a kind: «Расход» (used in procedures) is for consumables only.
    static func manual(for kind: ProductKind) -> [MovementType] {
        kind == .consumable ? manual : manual.filter { $0 != .usage }
    }
}

nonisolated extension MovementType {
    /// An unknown type reads as `.other`, so a newer server never breaks the movement lists.
    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = MovementType(rawValue: raw) ?? .other
    }
}

nonisolated struct StockMovement: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let productId: Int
    let productName: String
    /// The size that moved; `nil` from a server that predates sizes.
    var variantId: Int?
    /// Current name of that size ("" for a product without sizes).
    var variantName: String?
    let delta: Int
    /// Stock of the size after the movement.
    let quantityAfter: Int
    let type: MovementType
    let note: String?
    let saleId: Int?
    let appointmentId: Int?
    /// The stock count an adjustment came from.
    var revisionId: Int?
    /// The delivery a receipt belongs to.
    var deliveryId: Int? = nil
    /// Rubles paid: on a `purchase`, and on a `receipt` recorded with its unit cost (`unitCost × quantity`).
    var amount: Int?
    let employee: EmployeeRef?
    let createdAt: Date

    /// «Лабрет — 8 мм», or just the product name without a size.
    var displayName: String {
        guard let size = variantName.nonEmpty else { return productName }
        return "\(productName) — \(size)"
    }

    /// A purchase moves no stock: it records money, not units.
    var movesStock: Bool { type != .purchase }
}

nonisolated struct MovementResult: Codable, Sendable {
    let product: Product
    let movement: StockMovement
}

/// `POST /products/:id/movements/batch`.
nonisolated struct BatchMovementResult: Codable, Sendable {
    let product: Product
    /// In line order; a stock count skips the sizes whose count did not change.
    let movements: [StockMovement]
}
