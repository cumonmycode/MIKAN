import Foundation

/// Screens pushed inside the «Касса» tab (`AppState.posPath`). A receipt is not one of them: it is shown over the
/// screen it was opened from (`receiptFlow`).
nonisolated enum POSRoute: Hashable, Sendable {
    case salesHistory
    case shiftsHistory
}

/// Texts for the receipt that is being assembled in the cart.
nonisolated enum ReceiptDraft {
    /// "внесена переводом 15 октября" — the latest prepayment receipt of the appointment; `nil` without one.
    static func depositReceivedNote(_ operations: [DepositOperation]) -> String? {
        guard let receive = operations.last(where: { $0.type == .receive }) else { return nil }
        let date = DateText.dayMonth(receive.createdAt)
        guard let method = receive.method else { return "внесена \(date)" }
        return "внесена \(method.instrumental) \(date)"
    }
}

/// Search and category filter of the product catalog over a receipt.
nonisolated enum ProductCatalogFilter {
    static func categories(of products: [Product]) -> [String] {
        Array(Set(products.compactMap(\.category.nonEmpty))).sorted()
    }

    /// Products of `category` (all when `nil`) whose name, article, category, material, colour, insert,
    /// size names or size articles match `query`.
    static func apply(_ products: [Product], query: String, category: String?) -> [Product] {
        let needle = query.trimmed.lowercased()
        return products.filter { product in
            guard category == nil || product.category.nonEmpty == category else { return false }
            guard !needle.isEmpty else { return true }
            return searchText(of: product).contains(needle)
        }
    }

    /// Everything the search looks at, lowercased.
    static func searchText(of product: Product) -> String {
        let fields: [String?] = [product.name, product.sku, product.category, product.material, product.color, product.stone]
        let sizes: [String?] = product.variants.flatMap { [$0.name, $0.sku] }
        return (fields + sizes)
            .compactMap { $0.nonEmpty?.lowercased() }
            .joined(separator: " ")
    }
}
