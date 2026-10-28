import Foundation

/// A line of a sale that still has units to return.
nonisolated struct RefundableLine: Identifiable, Hashable, Sendable {
    let item: SaleItem
    /// Units returned by earlier refunds.
    let returned: Int
    /// Units that can still be returned (≥ 1).
    let refundable: Int

    var id: Int { item.id }
    /// A product unit that can go back to the stock (not a gift certificate).
    var isProduct: Bool { item.type == .product && !item.isCertificate }
}

/// What the refund sheet returns: chosen lines and how many units of each (`POST /sales/:id/refund` `items`).
nonisolated struct RefundSelection: Hashable, Sendable {
    /// The lines with something left to return, in the sale's order.
    let lines: [RefundableLine]
    /// Chosen units by sale line id; a line that is not chosen has no entry.
    private(set) var quantities: [Int: Int]

    /// Nothing is chosen, except the only line left, which is chosen whole.
    init(sale: Sale) {
        lines = sale.items.compactMap { item in
            let refundable = sale.refundableQuantity(of: item)
            guard refundable > 0 else { return nil }
            return RefundableLine(item: item, returned: sale.returnedQuantity(of: item), refundable: refundable)
        }
        if lines.count == 1, let only = lines.first {
            quantities = [only.id: only.refundable]
        } else {
            quantities = [:]
        }
    }

    func line(id: Int) -> RefundableLine? { lines.first { $0.id == id } }

    /// Units chosen of a line; `nil` — not chosen.
    func quantity(of id: Int) -> Int? { quantities[id] }

    func isSelected(_ id: Int) -> Bool { quantities[id] != nil }

    // MARK: Editing (each returns a new selection)

    /// Chooses a line with every unit left, or drops it.
    func toggling(_ id: Int) -> RefundSelection {
        guard let line = line(id: id) else { return self }
        var copy = self
        copy.quantities[id] = isSelected(id) ? nil : line.refundable
        return copy
    }

    /// Units of a chosen line, kept within 1…what is left of it.
    func settingQuantity(_ quantity: Int, of id: Int) -> RefundSelection {
        guard let line = line(id: id) else { return self }
        var copy = self
        copy.quantities[id] = min(max(1, quantity), line.refundable)
        return copy
    }

    /// «Вернуть весь чек»: every unit left of every line.
    func selectingAll() -> RefundSelection {
        var copy = self
        copy.quantities = Dictionary(uniqueKeysWithValues: lines.map { ($0.id, $0.refundable) })
        return copy
    }

    // MARK: Result

    var isEmpty: Bool { quantities.isEmpty }

    /// Everything left of the sale is chosen: the refund closes it.
    var isWhole: Bool {
        !lines.isEmpty && lines.allSatisfy { quantities[$0.id] == $0.refundable }
    }

    /// The request lines, in the sale's order.
    var items: [RefundItemBody] {
        lines.compactMap { line in
            quantities[line.id].map { RefundItemBody(saleItemId: line.id, quantity: $0) }
        }
    }

    var selectedLines: [RefundableLine] { lines.filter { isSelected($0.id) } }

    /// Some chosen units are products that can go back to the stock.
    var hasProducts: Bool { selectedLines.contains(where: \.isProduct) }

    /// A gift certificate is chosen: the refund cancels it.
    var hasCertificates: Bool { selectedLines.contains { $0.item.isCertificate } }

    var units: Int { quantities.values.reduce(0, +) }

    /// `nil` while nothing is chosen or the reason is blank.
    func body(reason: String, restock: Bool) -> RefundBody? {
        guard !isEmpty, let reason = RefundReason.normalized(reason) else { return nil }
        return RefundBody(reason: reason, restock: hasProducts && restock, items: items)
    }
}

/// The reason of a refund: required, quick chips for the usual ones.
nonisolated enum RefundReason {
    static let quick = ["Не подошёл размер", "Брак", "Передумал(а)"]
    /// The server's limit.
    static let maxLength = 500

    /// The trimmed reason, `nil` when blank or too long.
    static func normalized(_ text: String) -> String? {
        guard let reason = text.nonEmpty, reason.count <= maxLength else { return nil }
        return reason
    }

    /// Under the field: what is wrong, or `nil`.
    static func issue(_ text: String) -> String? {
        text.trimmed.count > maxLength ? "Причина — не длиннее \(maxLength) символов." : nil
    }
}
