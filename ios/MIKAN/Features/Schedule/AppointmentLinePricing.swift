import Foundation

// Prices of catalog lines for the appointment's master (docs/API.md «Service» `masterPrices`): a line takes the
// master's price when booked, and re-prices when the master changes while nobody has edited its price.

nonisolated extension Service {
    /// The master's price is «от» or a range — the final price is set per appointment. `priceFrom` stays the
    /// service's; a master's own `priceMax` replaces the catalog one.
    func hasVariablePrice(for masterId: Int?) -> Bool {
        guard let own = masterPrice(for: masterId) else { return hasVariablePrice }
        return priceFrom || own.priceMax != nil
    }

    /// The variant a saved line was booked with, by its name «Соски — Два».
    func variant(forLineName lineName: String) -> ServiceVariant? {
        variants.first { self.lineName(variant: $0) == lineName }
    }
}

extension DraftServiceLine {
    /// The price is still the one the catalog gave for the master it was priced for.
    var followsCatalog: Bool { autoPrice == price }

    /// A line of a saved appointment matched with the catalog: its variant (by the line name) and the price its
    /// master is charged now — equal to the line's price only while nobody edited it. Lines already matched, custom
    /// lines and services or variants missing from the catalog stay as they are (never re-priced).
    func resolvingAutoPrice(from catalog: [Service], masterId: Int?) -> DraftServiceLine {
        guard autoPrice == nil, let serviceId, let service = catalog.first(where: { $0.id == serviceId }) else {
            return self
        }
        var line = self
        if service.variants.isEmpty {
            line.autoPrice = service.price(for: masterId)
        } else if let variant = service.variant(forLineName: name) {
            line.variant = variant.name
            line.autoPrice = service.price(for: masterId, variant: variant)
        }
        return line
    }

    /// The line priced for `masterId`: a catalog line nobody edited takes that master's price; an edited price,
    /// a custom line and a service (or variant) missing from the catalog stay as they are.
    func repriced(for masterId: Int?, catalog: [Service]) -> DraftServiceLine {
        guard followsCatalog, let serviceId, let service = catalog.first(where: { $0.id == serviceId }) else {
            return self
        }
        let variant = variant.flatMap { name in service.variants.first { $0.name == name } }
        guard (variant == nil) == (self.variant == nil), variant != nil || service.variants.isEmpty else { return self }
        var line = self
        line.price = service.price(for: masterId, variant: variant)
        line.autoPrice = line.price
        line.isVariablePrice = variant == nil && service.hasVariablePrice(for: masterId)
        return line
    }
}
