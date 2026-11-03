import Foundation

/// Pure rules of a product category's items screen: who is in the category and who can be added to it.
/// Names compare trimmed, case- and «ё»-insensitive, like the server matches categories.
nonisolated enum CategoryMembership {
    /// The section's products in the category, by name.
    static func members(of category: String, in products: [Product]) -> [Product] {
        let key = InventoryFilter.normalized(category)
        return products
            .filter { InventoryFilter.normalized($0.category ?? "") == key }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// The rest of the section grouped by where each product is now: «Без категории» first (the items waiting for a
    /// category), then the other categories in staff order. The query matches every word in the name, article or
    /// current category.
    static func candidates(
        for category: String,
        section: CatalogSection,
        in products: [Product],
        registry: [CatalogCategory],
        query: String = ""
    ) -> [ProductGroup<Product>] {
        let key = InventoryFilter.normalized(category)
        let words = InventoryFilter.normalized(query).split(whereSeparator: \.isWhitespace).map(String.init)
        let rest = products.filter { InventoryFilter.normalized($0.category ?? "") != key && matches($0, words) }
        let groups = WarehouseGrouping.groups(rest, section: section, categories: registry)
        return groups.filter { $0.category == nil } + groups.filter { $0.category != nil }
    }

    private static func matches(_ product: Product, _ words: [String]) -> Bool {
        guard !words.isEmpty else { return true }
        let text = InventoryFilter.normalized([product.name, product.sku ?? "", product.category ?? ""].joined(separator: " "))
        return words.allSatisfy(text.contains)
    }

    /// «Перемещаю 2 из 5…» while items move one by one.
    static func progressText(done: Int, total: Int) -> String {
        "Перемещаю \(min(done + 1, total)) из \(total)…"
    }

    /// Why moving stopped; with several items, how many made it first.
    static func failureText(moved: Int, total: Int, reason: String) -> String {
        guard total > 1 else { return reason }
        return "Перемещено \(moved) из \(total). \(reason)"
    }
}
