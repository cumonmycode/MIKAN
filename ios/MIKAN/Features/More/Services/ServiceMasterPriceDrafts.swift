import Foundation

// Pure editor logic of «Цены у мастеров» (docs/API.md «Service» `masterPrices`): a master's own price, range
// maximum and variant prices. A saved entry loads and saves back exactly as it is; only a field left or made empty
// stands for the catalog value.

/// A master's range maximum.
nonisolated enum ServiceMasterPriceMax: Hashable, Sendable {
    /// Empty field: the catalog maximum (none while the catalog price is not a range).
    case catalog
    /// Saved without a maximum: the master's price has no upper bound, whatever the catalog's.
    case noMaximum
    case amount(Int)

    /// The amount typed in the «до» field.
    var amount: Int? {
        guard case .amount(let value) = self else { return nil }
        return value
    }

    /// What the master's entry sends for `catalogMax`.
    func resolved(catalogMax: Int?) -> Int? {
        switch self {
        case .catalog: catalogMax
        case .noMaximum: nil
        case .amount(let value): value
        }
    }
}

/// One master's prices in the editor; `nil` — the catalog value.
nonisolated struct ServiceMasterPriceDraft: Identifiable, Hashable, Sendable {
    let employeeId: Int
    var price: Int?
    var priceMax: ServiceMasterPriceMax = .catalog
    /// By variant row (`ServiceVariantDraft.id`): a renamed variant keeps its price, a removed one drops it.
    var variantPrices: [UUID: Int] = [:]

    var id: Int { employeeId }

    /// No own value at all: the master charges the catalog prices.
    var isBlank: Bool { price == nil && priceMax == .catalog && variantPrices.isEmpty }
}

/// The masters' prices of the service card; only masters with an own value have an entry. Entries of employees who
/// are not active masters now are kept as they are (the server keeps them for when they come back).
nonisolated struct ServiceMasterPricesDraft: Hashable, Sendable {
    /// What the server accepts per service.
    static let maxEntries = 20

    private(set) var entries: [ServiceMasterPriceDraft] = []

    init() {}

    /// Loads the saved prices exactly: a price equal to the catalog one stays the master's own (it does not follow
    /// later catalog changes), a saved entry without a maximum keeps none. Variant prices are matched to the variant
    /// rows by name; those of variants that no longer exist are dropped, as the server does.
    init(_ prices: [ServiceMasterPrice], variants: [ServiceVariantDraft]) {
        entries = prices.map { saved in
            var variantPrices: [UUID: Int] = [:]
            for own in saved.variants {
                guard let row = variants.first(where: { $0.name == own.name }) else { continue }
                variantPrices[row.id] = own.price
            }
            return ServiceMasterPriceDraft(
                employeeId: saved.employeeId,
                price: saved.price,
                priceMax: saved.priceMax.map(ServiceMasterPriceMax.amount) ?? .noMaximum,
                variantPrices: variantPrices
            )
        }
    }

    /// The master's prices; a blank entry when they charge the catalog price.
    func entry(for employeeId: Int) -> ServiceMasterPriceDraft {
        entries.first { $0.employeeId == employeeId } ?? ServiceMasterPriceDraft(employeeId: employeeId)
    }

    /// Replaces the master's prices in place; an entry left without own values is removed.
    mutating func set(_ entry: ServiceMasterPriceDraft) {
        guard let index = entries.firstIndex(where: { $0.employeeId == entry.employeeId }) else {
            if !entry.isBlank { entries.append(entry) }
            return
        }
        if entry.isBlank {
            entries.remove(at: index)
        } else {
            entries[index] = entry
        }
    }

    // MARK: - Body

    /// `ServiceBody.masterPrices`: masters with an own value, empty fields filled with the catalog values (a saved
    /// entry nobody touched goes back as it came). Prices of removed (or still blank) variants are dropped, a renamed
    /// variant's price goes under the new name.
    func prices(catalog: ServicePriceFields, variants: [ServiceVariantDraft]) -> [ServiceMasterPrice] {
        entries.compactMap { Self.resolved($0, catalog: catalog, variants: variants) }
    }

    /// The master's saved prices, or `nil` when nothing of theirs would be saved.
    static func resolved(
        _ entry: ServiceMasterPriceDraft,
        catalog: ServicePriceFields,
        variants: [ServiceVariantDraft]
    ) -> ServiceMasterPrice? {
        let own = variants.filter { !$0.isBlank }.compactMap { row in
            entry.variantPrices[row.id].map { ServiceMasterVariantPrice(name: row.name.trimmed, price: max(0, $0)) }
        }
        guard entry.price != nil || entry.priceMax != .catalog || !own.isEmpty else { return nil }
        return ServiceMasterPrice(
            employeeId: entry.employeeId,
            price: max(0, entry.price ?? catalog.price),
            priceMax: entry.priceMax.resolved(catalogMax: catalog.priceMax),
            variants: own
        )
    }

    // MARK: - Validation

    /// Why the master's prices cannot be saved (shown under their fields), or `nil`.
    static func rangeMessage(_ entry: ServiceMasterPriceDraft, catalog: ServicePriceFields) -> String? {
        guard let price = resolved(entry, catalog: catalog, variants: []), let maximum = price.priceMax else { return nil }
        return maximum > price.price ? nil : "Максимум должен быть больше минимума."
    }

    /// The first master whose range is broken.
    func invalidEntry(catalog: ServicePriceFields) -> ServiceMasterPriceDraft? {
        entries.first { Self.rangeMessage($0, catalog: catalog) != nil }
    }

    /// Why the masters' prices cannot be saved, or `nil` when they are valid.
    func validationMessage(catalog: ServicePriceFields, variants: [ServiceVariantDraft]) -> String? {
        if prices(catalog: catalog, variants: variants).count > Self.maxEntries {
            return "Свои цены — не больше чем у \(Self.maxEntries) мастеров."
        }
        if invalidEntry(catalog: catalog) != nil {
            return "У мастера максимум должен быть больше минимума."
        }
        return nil
    }
}

/// Texts of the masters' prices.
nonisolated enum ServiceMasterPriceText {
    /// Placeholder of an empty field: the catalog amount without the currency («2 500»).
    static func placeholder(_ amount: Int?) -> String {
        amount.map { Money.group(UInt(max(0, $0))) } ?? "—"
    }

    /// «3 000 ₽», «от 3 000 до 6 000 ₽» — how the master's price reads (`priceFrom` stays the service's).
    static func price(_ price: ServiceMasterPrice, priceFrom: Bool) -> String {
        Money.servicePrice(price.price, max: price.priceMax, from: priceFrom || price.priceMax != nil)
    }

    /// «Один — 3 000 ₽ · Два — 5 000 ₽»; `nil` without own variant prices.
    static func variants(_ variants: [ServiceMasterVariantPrice]) -> String? {
        guard !variants.isEmpty else { return nil }
        return variants.map { "\($0.name) — \(Money.format($0.price))" }.joined(separator: " · ")
    }
}
