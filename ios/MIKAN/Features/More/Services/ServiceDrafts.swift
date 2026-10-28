import Foundation

// Pure editor logic of the service card: price modes, variant rows, limits and the API body.

/// Limits of the service card from the API contract.
nonisolated enum ServiceLimits {
    static let durationStep = 15
    /// What the server accepts: 1 minute to 24 hours.
    static let durationRange = 1...(24 * 60)
    static let maxPhotos = 12
    static let maxVariants = 20
    static let maxVariantNameLength = 100
    static let maxImagePromptLength = 1000

    /// How many more work photos may be added.
    static func remainingPhotos(current count: Int) -> Int {
        max(0, maxPhotos - count)
    }

    static func durationMessage(_ minutes: Int) -> String? {
        durationRange.contains(minutes) ? nil : "Длительность — от 1 минуты до 24 часов."
    }

    /// Next stepper value on the 15-minute grid. Never steps below one step, so a shorter custom
    /// duration (10 min) is kept as is; values beyond the range come back into it.
    static func steppedDuration(_ minutes: Int, up: Bool) -> Int {
        let maximum = durationRange.upperBound
        if up {
            guard minutes < maximum else { return minutes }
            return min(maximum, (max(0, minutes) / durationStep + 1) * durationStep)
        }
        guard minutes <= maximum else { return maximum }
        let previous = (minutes - 1) / durationStep * durationStep
        return previous >= durationStep ? previous : minutes
    }

    static func canStepDuration(_ minutes: Int, up: Bool) -> Bool {
        steppedDuration(minutes, up: up) != minutes
    }

    /// Why an image prompt cannot be sent, or `nil` when it fits.
    static func imagePromptMessage(_ prompt: String) -> String? {
        let count = prompt.trimmed.count
        guard count > maxImagePromptLength else { return nil }
        return "Не длиннее \(maxImagePromptLength) символов (сейчас \(count))."
    }
}

// MARK: - Price

/// How the price of a service is entered: one amount, a lower bound or a range.
nonisolated enum ServicePriceMode: String, CaseIterable, Identifiable, Sendable {
    case fixed
    case from
    case range

    var id: String { rawValue }

    var title: String {
        switch self {
        case .fixed: "Фикс"
        case .from: "От"
        case .range: "Диапазон"
        }
    }

    init(priceMax: Int?, priceFrom: Bool) {
        if priceMax != nil {
            self = .range
        } else {
            self = priceFrom ? .from : .fixed
        }
    }
}

/// Service price as the API stores it.
nonisolated struct ServicePriceFields: Hashable, Sendable {
    let price: Int
    let priceMax: Int?
    let priceFrom: Bool
}

/// Editor state of a service price; maps the chosen mode to the API fields and validates it.
nonisolated struct ServicePriceDraft: Hashable, Sendable {
    var mode: ServicePriceMode
    /// The price («Фикс», «От») or the range minimum (0 reads as «до N»).
    var amount: Int
    /// Range maximum. Kept while switching modes so it is not lost.
    var maximum: Int?

    init(mode: ServicePriceMode = .fixed, amount: Int = 0, maximum: Int? = nil) {
        self.mode = mode
        self.amount = amount
        self.maximum = maximum
    }

    init(price: Int, priceMax: Int?, priceFrom: Bool) {
        self.init(mode: ServicePriceMode(priceMax: priceMax, priceFrom: priceFrom), amount: price, maximum: priceMax)
    }

    var fields: ServicePriceFields {
        let amount = max(0, amount)
        return switch mode {
        case .fixed: ServicePriceFields(price: amount, priceMax: nil, priceFrom: false)
        case .from: ServicePriceFields(price: amount, priceMax: nil, priceFrom: true)
        case .range: ServicePriceFields(price: amount, priceMax: maximum, priceFrom: true)
        }
    }

    /// Why the price cannot be saved, or `nil` when it is valid.
    var validationMessage: String? {
        guard mode == .range else { return nil }
        guard let maximum, maximum > 0 else { return "Укажите максимальную цену." }
        guard maximum > amount else { return "Максимум должен быть больше минимума." }
        return nil
    }

    var isValid: Bool { validationMessage == nil }

    /// How the price reads in the catalog and to clients: «от 2 000 до 5 000 ₽».
    var previewText: String {
        let fields = fields
        return Money.servicePrice(fields.price, max: fields.priceMax, from: fields.priceFrom)
    }
}

// MARK: - Variants

/// Editable row of the variants editor.
nonisolated struct ServiceVariantDraft: Identifiable, Hashable, Sendable {
    let id: UUID
    var name: String
    var price: Int
    /// The variant overrides the service duration.
    var hasDuration: Bool
    /// Used only when `hasDuration` is on; keeps the last value while the toggle is off.
    var durationMin: Int
    /// Price a new row was pre-filled with; a row still at it (and without a name) counts as untouched.
    let seedPrice: Int

    init(
        id: UUID = UUID(),
        name: String = "",
        price: Int = 0,
        durationMin: Int? = nil,
        defaultDuration: Int,
        seedPrice: Int = 0
    ) {
        self.id = id
        self.name = name
        self.price = price
        self.hasDuration = durationMin != nil
        self.durationMin = durationMin ?? defaultDuration
        self.seedPrice = seedPrice
    }

    /// A row added in the editor, pre-filled with the service price and duration.
    static func new(price: Int, defaultDuration: Int) -> ServiceVariantDraft {
        ServiceVariantDraft(price: price, defaultDuration: defaultDuration, seedPrice: price)
    }

    init(_ variant: ServiceVariant, defaultDuration: Int) {
        self.init(name: variant.name, price: variant.price, durationMin: variant.durationMin, defaultDuration: defaultDuration)
    }

    /// An untouched row (no name, the pre-filled or zero price, no own duration): skipped on save.
    var isBlank: Bool { name.trimmed.isEmpty && (price == 0 || price == seedPrice) && !hasDuration }

    var variant: ServiceVariant {
        ServiceVariant(name: name.trimmed, price: max(0, price), durationMin: hasDuration ? durationMin : nil)
    }
}

/// Operations on the variant rows; each returns a new array.
nonisolated enum ServiceVariantDrafts {
    static func drafts(from variants: [ServiceVariant], defaultDuration: Int) -> [ServiceVariantDraft] {
        variants.map { ServiceVariantDraft($0, defaultDuration: defaultDuration) }
    }

    /// Variants to save; blank rows are skipped.
    static func variants(from drafts: [ServiceVariantDraft]) -> [ServiceVariant] {
        drafts.filter { !$0.isBlank }.map(\.variant)
    }

    /// Why the variants cannot be saved, or `nil` when they are valid.
    static func validationMessage(for drafts: [ServiceVariantDraft]) -> String? {
        let filled = drafts.filter { !$0.isBlank }
        if filled.count > ServiceLimits.maxVariants {
            return "Не больше \(ServiceLimits.maxVariants) вариантов."
        }
        if filled.contains(where: { $0.name.trimmed.isEmpty }) {
            return "Укажите название у каждого варианта."
        }
        if filled.contains(where: { $0.name.trimmed.count > ServiceLimits.maxVariantNameLength }) {
            return "Название варианта — не длиннее \(ServiceLimits.maxVariantNameLength) символов."
        }
        let names = filled.map { $0.name.trimmed.lowercased() }
        if Set(names).count != names.count {
            return "Названия вариантов не должны повторяться."
        }
        if filled.contains(where: { $0.hasDuration && ServiceLimits.durationMessage($0.durationMin) != nil }) {
            return "Длительность варианта — от 1 минуты до 24 часов."
        }
        return nil
    }

    static func removing(_ id: UUID, from drafts: [ServiceVariantDraft]) -> [ServiceVariantDraft] {
        drafts.filter { $0.id != id }
    }

    /// Moves the row by `offset` positions (−1 = up), clamped to the list bounds.
    static func moving(_ id: UUID, by offset: Int, in drafts: [ServiceVariantDraft]) -> [ServiceVariantDraft] {
        guard let index = drafts.firstIndex(where: { $0.id == id }) else { return drafts }
        let target = min(max(0, index + offset), drafts.count - 1)
        guard target != index else { return drafts }
        var result = drafts
        let row = result.remove(at: index)
        result.insert(row, at: target)
        return result
    }
}

// MARK: - Prepayment

/// «Нужна предоплата» toggle and its amount; the amount is kept while the toggle is off.
nonisolated struct ServiceDepositDraft: Hashable, Sendable {
    var isRequired: Bool
    var requiredAmount: Int

    init(isRequired: Bool = false, requiredAmount: Int = 0) {
        self.isRequired = isRequired
        self.requiredAmount = requiredAmount
    }

    init(depositAmount: Int) {
        self.init(isRequired: depositAmount > 0, requiredAmount: max(0, depositAmount))
    }

    /// `ServiceBody.depositAmount`: 0 — no prepayment.
    var amount: Int { isRequired ? max(0, requiredAmount) : 0 }

    var validationMessage: String? {
        isRequired && requiredAmount <= 0 ? "Укажите сумму предоплаты." : nil
    }

    /// Non-blocking hint: a prepayment above a fixed price is most likely a typo.
    func priceHint(for price: ServicePriceFields) -> String? {
        guard isRequired, !price.priceFrom, price.price > 0, requiredAmount > price.price else { return nil }
        return "Предоплата больше цены услуги (\(Money.format(price.price)))."
    }
}

// MARK: - Whole card

/// Everything the service editor edits; validates it and builds the API body.
nonisolated struct ServiceEditorDraft: Hashable, Sendable {
    var name: String
    var category: ServiceCategory
    var group: String
    var price: ServicePriceDraft
    var durationMin: Int
    var variants: [ServiceVariantDraft]
    /// «Цены у мастеров»: masters' own prices; empty fields follow the catalog.
    var masterPrices: ServiceMasterPricesDraft
    var imageUrl: String?
    var imagePrompt: String
    var photos: [String]
    var description: String
    var deposit: ServiceDepositDraft
    var aftercareTemplateId: Int?
    /// «Свежий прокол» / «Свежее тату» (new services: on).
    var freshProcedure: Bool
    /// «После визита»: the healing check-in and the jewelry change reminder.
    var followUps: ServiceFollowUpDraft
    /// Compatible catalog jewelry, in the order staff linked it.
    var jewelryIds: [Int]
    /// Consumables one procedure uses.
    var consumables: [ServiceConsumable]
    var active: Bool
    var sort: Int

    static let defaultCategory = ServiceCategory.piercing
    static let defaultDuration = 60

    init(service: Service?, nextSort: Int) {
        let duration = service?.durationMin ?? Self.defaultDuration
        name = service?.name ?? ""
        category = service?.category ?? Self.defaultCategory
        group = service?.group ?? ""
        price = service.map { ServicePriceDraft(price: $0.price, priceMax: $0.priceMax, priceFrom: $0.priceFrom) } ?? ServicePriceDraft()
        durationMin = duration
        let variantRows = ServiceVariantDrafts.drafts(from: service?.variants ?? [], defaultDuration: duration)
        variants = variantRows
        masterPrices = ServiceMasterPricesDraft(service?.masterPrices ?? [], variants: variantRows)
        imageUrl = service?.imageUrl.nonEmpty
        imagePrompt = service?.imagePrompt ?? ""
        photos = service?.photos ?? []
        description = service?.description ?? ""
        deposit = ServiceDepositDraft(depositAmount: service?.depositAmount ?? 0)
        aftercareTemplateId = service?.aftercareTemplateId
        freshProcedure = service?.freshProcedure ?? true
        followUps = service.map { ServiceFollowUpDraft(healingCheckDays: $0.healingCheckDays, jewelryChangeWeeks: $0.jewelryChangeWeeks) }
            ?? .newService
        jewelryIds = service?.jewelryIds ?? []
        consumables = service?.consumables ?? []
        active = service?.active ?? true
        sort = service?.sort ?? max(0, nextSort)
    }

    var nameMessage: String? { name.trimmed.isEmpty ? "Укажите название услуги." : nil }
    var durationMessage: String? { ServiceLimits.durationMessage(durationMin) }
    var variantsMessage: String? { ServiceVariantDrafts.validationMessage(for: variants) }
    var masterPricesMessage: String? { masterPrices.validationMessage(catalog: price.fields, variants: variants) }
    var imagePromptMessage: String? { ServiceLimits.imagePromptMessage(imagePrompt) }
    var photosMessage: String? {
        photos.count > ServiceLimits.maxPhotos ? "Не больше \(ServiceLimits.maxPhotos) фото работ." : nil
    }
    var jewelryMessage: String? { ServiceJewelryLinks.validationMessage(jewelryIds) }
    var consumablesMessage: String? { ServiceConsumptionNorms.validationMessage(consumables) }

    /// Why «Сохранить» is disabled (the first problem), or `nil` when the card can be saved.
    /// Each part is also shown next to its own field.
    var validationMessage: String? {
        nameMessage
            ?? durationMessage
            ?? price.validationMessage
            ?? variantsMessage
            ?? masterPricesMessage
            ?? imagePromptMessage
            ?? photosMessage
            ?? deposit.validationMessage
            ?? jewelryMessage
            ?? consumablesMessage
    }

    var canSave: Bool { validationMessage == nil }

    var body: ServiceBody {
        let fields = price.fields
        return ServiceBody(
            name: name.trimmed,
            category: category,
            group: Nullable(group.nonEmpty),
            price: fields.price,
            priceMax: Nullable(fields.priceMax),
            priceFrom: fields.priceFrom,
            durationMin: durationMin,
            description: Nullable(description.nonEmpty),
            imageUrl: Nullable(imageUrl.nonEmpty),
            imagePrompt: Nullable(imagePrompt.nonEmpty),
            photos: photos,
            variants: ServiceVariantDrafts.variants(from: variants),
            depositAmount: deposit.amount,
            masterPrices: masterPrices.prices(catalog: fields, variants: variants),
            aftercareTemplateId: Nullable(aftercareTemplateId),
            freshProcedure: freshProcedure,
            healingCheckDays: Nullable(followUps.healingCheckDays),
            jewelryChangeWeeks: Nullable(followUps.jewelryChangeWeeks),
            jewelryIds: jewelryIds,
            consumables: consumables,
            active: active,
            sort: sort
        )
    }

    /// Footer of the memo section: whether completing an appointment with this service sends the memo.
    var aftercareHint: String {
        freshProcedure
            ? "Клиенту с подключённым Telegram придёт памятка по уходу после записи с этой услугой. Шаблон — памятка по умолчанию."
            : "Памятка по уходу по этой услуге не отправляется — например, для замены украшения, чистки или консультации."
    }
}

nonisolated extension ServiceBody {
    /// Full body of an existing service (PATCH replaces every field but the masters' prices, which stay unchanged).
    init(_ service: Service) {
        self.init(
            name: service.name,
            category: service.category,
            group: Nullable(service.group.nonEmpty),
            price: service.price,
            priceMax: Nullable(service.priceMax),
            priceFrom: service.priceFrom,
            durationMin: service.durationMin,
            description: Nullable(service.description.nonEmpty),
            imageUrl: Nullable(service.imageUrl.nonEmpty),
            imagePrompt: Nullable(service.imagePrompt.nonEmpty),
            photos: service.photos,
            variants: service.variants,
            depositAmount: service.depositAmount,
            aftercareTemplateId: Nullable(service.aftercareTemplateId),
            freshProcedure: service.freshProcedure,
            healingCheckDays: Nullable(service.healingCheckDays),
            jewelryChangeWeeks: Nullable(service.jewelryChangeWeeks),
            jewelryIds: service.jewelryIds,
            consumables: service.consumables,
            active: service.active,
            sort: service.sort
        )
    }
}
