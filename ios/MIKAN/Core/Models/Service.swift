import Foundation

nonisolated enum ServiceCategory: String, Codable, CaseIterable, Identifiable, Sendable {
    case tattoo
    case piercing
    case other

    var id: String { rawValue }

    var title: String {
        switch self {
        case .tattoo: "Тату"
        case .piercing: "Пирсинг"
        case .other: "Другое"
        }
    }

    var symbol: String {
        switch self {
        case .tattoo: "paintbrush.pointed"
        case .piercing: "sparkle"
        case .other: "square.grid.2x2"
        }
    }

    /// Name of the service switch that sends aftercare memos (`Service.freshProcedure`).
    var freshProcedureTitle: String {
        switch self {
        case .piercing: "Свежий прокол"
        case .tattoo: "Свежее тату"
        case .other: "Нужна памятка по уходу"
        }
    }
}

/// A priced option of a service («Один» / «Два»). Booking it books `"<service> — <variant>"` at the variant price.
nonisolated struct ServiceVariant: Codable, Hashable, Sendable {
    var name: String
    var price: Int
    /// Overrides the service duration when set.
    var durationMin: Int?
}

/// A master's own price of one variant (by its name).
nonisolated struct ServiceMasterVariantPrice: Codable, Hashable, Sendable {
    var name: String
    var price: Int
}

/// A master's own prices for a service (docs/API.md «Service» `masterPrices`).
nonisolated struct ServiceMasterPrice: Codable, Hashable, Sendable {
    var employeeId: Int
    var price: Int
    var priceMax: Int?
    var variants: [ServiceMasterVariantPrice] = []
}

nonisolated extension ServiceMasterPrice {
    private enum CodingKeys: String, CodingKey { case employeeId, price, priceMax, variants }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        employeeId = try c.decode(Int.self, forKey: .employeeId)
        price = try c.decode(Int.self, forKey: .price)
        priceMax = try c.decodeIfPresent(Int.self, forKey: .priceMax)
        variants = try c.decodeIfPresent([ServiceMasterVariantPrice].self, forKey: .variants) ?? []
    }
}

nonisolated struct Service: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    var name: String
    var category: ServiceCategory
    /// Subgroup inside the category («Ухо», «Лицо», «Доп. услуги»).
    var group: String?
    /// Base / minimal price — the default amount of a booked line.
    var price: Int
    /// Upper bound of a price range: «от 2 000 до 5 000 ₽», or «до 10 000 ₽» when `price` is 0.
    var priceMax: Int?
    /// `true` means the final price is set per appointment («от N ₽», or any range).
    var priceFrom: Bool
    var durationMin: Int
    var description: String?
    /// Schematic cover picture (server-relative path); the bot sends it to clients.
    var imageUrl: String?
    /// What the cover picture shows — the generation prompt subject; `nil` = derived from name and description.
    var imagePrompt: String?
    /// Photos of real works (server-relative paths).
    var photos: [String] = []
    var variants: [ServiceVariant] = []
    /// Prepayment required to book this service; 0 — none.
    var depositAmount = 0
    /// Masters' own prices; `[]` — every master charges the catalog price (and from an older server).
    var masterPrices: [ServiceMasterPrice] = []
    var aftercareTemplateId: Int?
    /// «Свежий прокол» / «Свежее тату»: completing an appointment sends aftercare memos only for such services.
    var freshProcedure = true
    /// The bot asks the client «Как заживает?» this many days after the visit (1…60); `nil` — never.
    var healingCheckDays: Int?
    /// The bot suggests changing the jewelry this many weeks after the visit (1…52); `nil` — never.
    var jewelryChangeWeeks: Int?
    /// Catalog jewelry compatible with the service (the bot offers it).
    var jewelryIds: [Int] = []
    /// Consumables one procedure uses; deducted when an appointment with the service is completed.
    var consumables: [ServiceConsumable] = []
    var active: Bool
    var sort: Int

    /// Booking this service needs a prepayment.
    var requiresDeposit: Bool { depositAmount > 0 }

    var ref: ServiceRef { ServiceRef(id: id, name: name, category: category) }

    /// «2 500 ₽», «от 15 000 ₽», «от 2 000 до 5 000 ₽», «до 10 000 ₽», «Бесплатно».
    var priceText: String { Money.servicePrice(price, max: priceMax, from: priceFrom) }

    /// The final price is chosen per appointment (range or «от»).
    var hasVariablePrice: Bool { priceFrom || priceMax != nil }

    /// Picture for lists and cards: the schematic cover, else the first work photo.
    var coverPath: String? { imageUrl.nonEmpty ?? photos.first }

    /// Group title used for sectioning, «Другое» when empty.
    var groupTitle: String { group.nonEmpty ?? "Другое" }

    /// Name of a booked line for the given variant: «Соски — Два».
    func lineName(variant: ServiceVariant?) -> String {
        guard let variant else { return name }
        return "\(name) — \(variant.name)"
    }

    /// The master's own prices, `nil` when they charge the catalog price (or no master is known).
    func masterPrice(for masterId: Int?) -> ServiceMasterPrice? {
        guard let masterId else { return nil }
        return masterPrices.first { $0.employeeId == masterId }
    }

    /// The price of a line for a master (docs/API.md «Service» `masterPrices`): their variant price ?? the variant's,
    /// or their price ?? the catalog price.
    func price(for masterId: Int?, variant: ServiceVariant? = nil) -> Int {
        let own = masterPrice(for: masterId)
        if let variant {
            return own?.variants.first { $0.name == variant.name }?.price ?? variant.price
        }
        return own?.price ?? price
    }

    /// «3 000 ₽», «от 3 000 ₽»… — the price text for a master (the catalog text when they have no own price).
    func priceText(for masterId: Int?) -> String {
        guard let own = masterPrice(for: masterId) else { return priceText }
        return Money.servicePrice(own.price, max: own.priceMax, from: priceFrom || own.priceMax != nil)
    }
}

nonisolated extension Service {
    private enum CodingKeys: String, CodingKey {
        case id, name, category, group, price, priceMax, priceFrom, durationMin, description
        case imageUrl, imagePrompt, photos, variants, depositAmount, masterPrices, aftercareTemplateId, freshProcedure, jewelryIds, consumables
        case healingCheckDays, jewelryChangeWeeks
        case active, sort
    }

    /// Tolerates servers that predate service cards (no group, photos, variants, cover), prepayments, the
    /// fresh-procedure switch (such a server sends memos for any service: read as `true`) or post-visit follow-ups.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        category = try c.decode(ServiceCategory.self, forKey: .category)
        group = try c.decodeIfPresent(String.self, forKey: .group)
        price = try c.decode(Int.self, forKey: .price)
        priceMax = try c.decodeIfPresent(Int.self, forKey: .priceMax)
        priceFrom = try c.decode(Bool.self, forKey: .priceFrom)
        durationMin = try c.decode(Int.self, forKey: .durationMin)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        imageUrl = try c.decodeIfPresent(String.self, forKey: .imageUrl)
        imagePrompt = try c.decodeIfPresent(String.self, forKey: .imagePrompt)
        photos = try c.decodeIfPresent([String].self, forKey: .photos) ?? []
        variants = try c.decodeIfPresent([ServiceVariant].self, forKey: .variants) ?? []
        depositAmount = try c.decodeIfPresent(Int.self, forKey: .depositAmount) ?? 0
        masterPrices = try c.decodeIfPresent([ServiceMasterPrice].self, forKey: .masterPrices) ?? []
        aftercareTemplateId = try c.decodeIfPresent(Int.self, forKey: .aftercareTemplateId)
        freshProcedure = try c.decodeIfPresent(Bool.self, forKey: .freshProcedure) ?? true
        healingCheckDays = try c.decodeIfPresent(Int.self, forKey: .healingCheckDays)
        jewelryChangeWeeks = try c.decodeIfPresent(Int.self, forKey: .jewelryChangeWeeks)
        jewelryIds = try c.decodeIfPresent([Int].self, forKey: .jewelryIds) ?? []
        consumables = try c.decodeIfPresent([ServiceConsumable].self, forKey: .consumables) ?? []
        active = try c.decode(Bool.self, forKey: .active)
        sort = try c.decode(Int.self, forKey: .sort)
    }
}

/// Embedded service summary used inside other entities.
nonisolated struct ServiceRef: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let name: String
    let category: ServiceCategory
}

nonisolated struct AftercareStep: Codable, Hashable, Sendable {
    var dayOffset: Int
    var text: String
}

nonisolated struct AftercareTemplate: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    var name: String
    var category: ServiceCategory
    var steps: [AftercareStep]
    let createdAt: Date
    var updatedAt: Date
}
