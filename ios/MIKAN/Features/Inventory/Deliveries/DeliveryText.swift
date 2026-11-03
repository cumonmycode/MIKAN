import Foundation

/// Texts of the delivery screens and of the receipts a delivery made.
nonisolated enum DeliveryText {
    /// How the server starts the note of every receipt of a delivery: «Поставка №4» (+ « · <note>»).
    static let notePrefix = "Поставка №"

    /// «Поставка №4».
    static func title(number: Int) -> String { notePrefix + String(number) }

    /// «3 позиции».
    static func positions(_ count: Int) -> String {
        Plural.count(count, one: "позиция", few: "позиции", many: "позиций")
    }

    /// «14 шт»; «14 единиц» when the unit is not known or the lines are counted in different ones.
    static func units(_ count: Int, unit: String?) -> String {
        guard let unit else { return Plural.count(count, one: "единица", few: "единицы", many: "единиц") }
        return InventoryText.quantity(count, unit: unit)
    }

    /// «3 позиции · 14 шт».
    static func summary(positions: Int, units count: Int, unit: String?) -> String {
        "\(self.positions(positions)) · \(units(count, unit: unit))"
    }

    /// A list row: «15 окт., 11:00 · Industrial Strength · Анна».
    static func subtitle(_ delivery: StockDelivery) -> String {
        [DateText.dateTime(delivery.createdAt), delivery.supplier.nonEmpty, delivery.employee?.name]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    /// The delivery number in a receipt's note «Поставка №4 · …»; `nil` when the note does not start with it.
    static func number(inNote note: String?) -> Int? {
        guard let note, note.hasPrefix(notePrefix) else { return nil }
        return Int(note.dropFirst(notePrefix.count).prefix { $0.isASCII && $0.isNumber })
    }

    /// The operation of a delivery receipt: «Поставка №4», «Поставка» when its note does not name the number.
    static func movementTitle(note: String?) -> String {
        number(inNote: note).map(title(number:)) ?? "Поставка"
    }

    /// The note of a delivery receipt without «Поставка №4» (the title says it): the delivery's own note, or `nil`.
    static func movementNote(_ note: String?) -> String? {
        guard let note, let number = number(inNote: note) else { return note.nonEmpty }
        let rest = note.dropFirst(title(number: number).count)
        let separator = " · "
        return String(rest.hasPrefix(separator) ? rest.dropFirst(separator.count) : rest).nonEmpty
    }
}

/// What the delivery picker lists and finds.
nonisolated enum DeliveryCatalog {
    /// The kinds a delivery takes, in the picker's order.
    static let kinds: [ProductKind] = [.jewelry, .goods, .consumable]

    /// Products a delivery can take: by kind (jewelry, goods, consumables), the shown ones first, then by name.
    static func options(_ products: [Product]) -> [Product] {
        products.filter(DeliveryDraft.accepts).sorted { lhs, rhs in
            let lhsKind = kinds.firstIndex(of: lhs.kind) ?? kinds.count
            let rhsKind = kinds.firstIndex(of: rhs.kind) ?? kinds.count
            if lhsKind != rhsKind { return lhsKind < rhsKind }
            if lhs.active != rhs.active { return lhs.active }
            return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
    }

    /// One kind (`nil` — all) and the search over the name, article, category, supplier and sizes.
    static func filter(_ products: [Product], kind: ProductKind?, query: String) -> [Product] {
        let text = query.trimmed
        return products.filter { product in
            guard kind == nil || product.kind == kind else { return false }
            guard !text.isEmpty else { return true }
            let sizes: [String?] = product.variants.flatMap { [$0.name, $0.sku] }
            let fields: [String?] = [product.name, product.sku, product.category, product.supplier] + sizes
            return fields.contains { $0?.localizedCaseInsensitiveContains(text) == true }
        }
    }
}

/// Supplier names offered under the field.
nonisolated enum DeliverySupplierSuggestions {
    static let limit = 8

    /// The most recent suppliers; while typing, the names containing the text (not the one typed exactly).
    static func matching(_ suppliers: [StockSupplier], typed: String) -> [String] {
        let text = typed.trimmed
        let names = suppliers.map(\.name)
        guard !text.isEmpty else { return Array(names.prefix(limit)) }
        return Array(names.filter { name in
            name.localizedCaseInsensitiveContains(text) && name.caseInsensitiveCompare(text) != .orderedSame
        }.prefix(limit))
    }
}
