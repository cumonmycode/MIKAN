import Foundation

/// One size received in a delivery: how many units and what one cost.
nonisolated struct DeliveryDraftLine: Identifiable, Hashable, Sendable {
    let productId: Int
    let variantId: Int
    let productName: String
    /// "" for a product without sizes.
    let sizeName: String
    let unit: String
    /// Typed by the user; `nil` while the field is cleared.
    var quantity: Int?
    /// Pre-filled with the size's current cost; `nil` — received without a cost.
    var unitCost: Int?

    var id: Int { variantId }

    /// «Лабрет — 8 мм», or just the product name without a size.
    var title: String {
        guard let size = sizeName.nonEmpty else { return productName }
        return "\(productName) — \(size)"
    }

    /// `quantity × unitCost`; `nil` without either.
    var amount: Int? {
        guard let quantity, let unitCost else { return nil }
        return quantity * unitCost
    }
}

/// Pure state of the delivery editor (`POST /stock/deliveries`): a supplier, a note and the sizes received.
nonisolated struct DeliveryDraft: Hashable, Sendable {
    /// The server's limits.
    static let maxLines = 200
    static let maxQuantity = 10_000
    static let maxUnitCost = StockBatchDraft.maxUnitCost
    static let maxSupplierLength = 100
    static let maxNoteLength = 500

    var supplier = ""
    var note = ""
    private(set) var lines: [DeliveryDraftLine] = []

    /// Products a delivery takes: counted in units (jewelry, goods, consumables in `quantity` mode). Presence
    /// consumables are bought by sum; archived products are never listed.
    static func accepts(_ product: Product) -> Bool { !product.isPresenceTracked }

    func line(variantId: Int) -> DeliveryDraftLine? { lines.first { $0.variantId == variantId } }

    /// Units of a product already in the delivery (all its sizes).
    func quantity(ofProduct productId: Int) -> Int {
        lines.filter { $0.productId == productId }.reduce(0) { $0 + ($1.quantity ?? 0) }
    }

    // MARK: Editing (each returns a new draft)

    /// Adds units of one size; a size already in the delivery gets them on top.
    func adding(_ product: Product, variantId: Int, quantity: Int = 1) -> DeliveryDraft {
        guard Self.accepts(product), quantity > 0, let variant = product.variant(id: variantId) else { return self }
        var copy = self
        if let index = lines.firstIndex(where: { $0.variantId == variantId }) {
            copy.lines[index].quantity = (lines[index].quantity ?? 0) + quantity
        } else {
            copy.lines.append(Self.line(product, variant, quantity: quantity))
        }
        return copy
    }

    /// The sizes screen: sets the units of each size of the product; a size without units leaves the delivery.
    /// Sizes already in it keep their place and cost, new ones follow in the product's size order.
    func settingQuantities(_ quantities: [Int: Int], of product: Product) -> DeliveryDraft {
        guard Self.accepts(product) else { return self }
        var copy = self
        for variant in product.variants {
            let quantity = quantities[variant.id] ?? 0
            if let index = copy.lines.firstIndex(where: { $0.variantId == variant.id }) {
                if quantity > 0 {
                    copy.lines[index].quantity = quantity
                } else {
                    copy.lines.remove(at: index)
                }
            } else if quantity > 0 {
                copy.lines.append(Self.line(product, variant, quantity: quantity))
            }
        }
        return copy
    }

    func settingQuantity(_ quantity: Int?, forLine variantId: Int) -> DeliveryDraft {
        update(variantId) { $0.quantity = quantity }
    }

    func settingUnitCost(_ unitCost: Int?, forLine variantId: Int) -> DeliveryDraft {
        update(variantId) { $0.unitCost = unitCost }
    }

    func removingLines(at offsets: IndexSet) -> DeliveryDraft {
        var copy = self
        copy.lines = lines.enumerated().filter { !offsets.contains($0.offset) }.map(\.element)
        return copy
    }

    private func update(_ variantId: Int, _ change: (inout DeliveryDraftLine) -> Void) -> DeliveryDraft {
        guard let index = lines.firstIndex(where: { $0.variantId == variantId }) else { return self }
        var copy = self
        change(&copy.lines[index])
        return copy
    }

    private static func line(_ product: Product, _ variant: ProductVariant, quantity: Int) -> DeliveryDraftLine {
        DeliveryDraftLine(
            productId: product.id, variantId: variant.id, productName: product.name, sizeName: variant.name,
            unit: product.unitLabel, quantity: quantity, unitCost: product.cost(of: variant)
        )
    }

    // MARK: Totals

    var isEmpty: Bool { lines.isEmpty }
    /// Sizes received.
    var positions: Int { lines.count }
    var units: Int { lines.reduce(0) { $0 + ($1.quantity ?? 0) } }
    /// Σ amounts of the lines with a cost, as the server counts `total`.
    var total: Int { lines.reduce(0) { $0 + ($1.amount ?? 0) } }
    /// Lines received without a cost.
    var uncostedLines: Int { lines.filter { $0.unitCost == nil }.count }
    /// The unit all lines share («шт»), `nil` when they differ.
    var commonUnit: String? {
        let units = Set(lines.map(\.unit))
        return units.count == 1 ? units.first : nil
    }

    // MARK: Validation

    /// Why the delivery cannot be sent, or `nil` when it can.
    var validationMessage: String? {
        if lines.isEmpty { return "Добавьте хотя бы одну позицию." }
        if lines.count > Self.maxLines { return "В одной поставке — не больше \(Self.maxLines) позиций." }
        if let line = lines.first(where: { ($0.quantity ?? 0) <= 0 }) {
            return "Укажите количество: \(line.title)."
        }
        if let line = lines.first(where: { ($0.quantity ?? 0) > Self.maxQuantity }) {
            return "Не больше \(Money.group(UInt(Self.maxQuantity))) \(line.unit) в одной строке: \(line.title)."
        }
        if lines.contains(where: { ($0.unitCost ?? 0) > Self.maxUnitCost }) {
            return "Цена закупки не может быть больше \(Money.format(Self.maxUnitCost))."
        }
        if supplier.trimmed.count > Self.maxSupplierLength {
            return "Поставщик — не длиннее \(Self.maxSupplierLength) символов."
        }
        if note.trimmed.count > Self.maxNoteLength {
            return "Комментарий — не длиннее \(Self.maxNoteLength) символов."
        }
        return nil
    }

    var canSubmit: Bool { validationMessage == nil }

    var body: DeliveryBody {
        DeliveryBody(
            supplier: supplier.nonEmpty,
            note: note.nonEmpty,
            lines: lines.map { line in
                DeliveryLineBody(
                    productId: line.productId, variantId: line.variantId, quantity: line.quantity ?? 0, unitCost: line.unitCost
                )
            }
        )
    }
}
