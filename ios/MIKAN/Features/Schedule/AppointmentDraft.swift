import Foundation
import SwiftUI // `remove(atOffsets:)` for swipe-to-delete

/// Prefill for the inline "new client" form (e.g. from a booking request).
struct ClientSuggestion: Hashable {
    var name: String
    var phone: String
}

/// One service line being edited: a catalog service (or one of its variants) or a custom line.
struct DraftServiceLine: Identifiable, Hashable {
    let id: UUID
    /// `nil` for a custom line.
    var serviceId: Int?
    var name: String
    var price: Int
    var durationMin: Int?
    /// The catalog price is «от» / a range — the final price is set per appointment.
    var isVariablePrice: Bool
    var category: ServiceCategory?
    /// Prepayment the catalog service asks for (`Service.depositAmount`); 0 for a custom line.
    var depositAmount: Int
    /// Name of the booked variant, so the line can be re-priced for another master.
    var variant: String?
    /// The catalog price of the line for the master it was priced for: while `price` equals it, the line re-prices
    /// with the master (see `AppointmentLinePricing.swift`). `nil` — a custom line, or one not matched with the catalog.
    var autoPrice: Int?

    init(
        id: UUID = UUID(),
        serviceId: Int?,
        name: String,
        price: Int,
        durationMin: Int?,
        isVariablePrice: Bool = false,
        category: ServiceCategory? = nil,
        depositAmount: Int = 0,
        variant: String? = nil,
        autoPrice: Int? = nil
    ) {
        self.id = id
        self.serviceId = serviceId
        self.name = name
        self.price = price
        self.durationMin = durationMin
        self.isVariablePrice = isVariablePrice
        self.category = category
        self.depositAmount = max(0, depositAmount)
        self.variant = variant
        self.autoPrice = autoPrice
    }

    /// A booked catalog service at the master's price (the catalog one while no master is chosen); a variant brings
    /// its own name, price and (optionally) duration.
    init(service: Service, variant: ServiceVariant? = nil, masterId: Int? = nil) {
        let price = service.price(for: masterId, variant: variant)
        self.init(
            serviceId: service.id,
            name: service.lineName(variant: variant),
            price: price,
            durationMin: variant?.durationMin ?? service.durationMin,
            isVariablePrice: variant == nil && service.hasVariablePrice(for: masterId),
            category: service.category,
            depositAmount: service.depositAmount,
            variant: variant?.name,
            autoPrice: price
        )
    }

    /// A line of a saved appointment.
    init(line: AppointmentServiceLine) {
        self.init(
            serviceId: line.serviceId,
            name: line.name,
            price: line.price,
            durationMin: line.durationMin,
            category: line.category
        )
    }

    var body: AppointmentServiceBody {
        AppointmentServiceBody(serviceId: serviceId, name: name.trimmed, price: price, durationMin: durationMin)
    }

    /// The line with the prepayment of its catalog service; lines of saved appointments don't carry it.
    func resolvingDeposit(from catalog: [Service]) -> DraftServiceLine {
        guard let serviceId, let service = catalog.first(where: { $0.id == serviceId }) else { return self }
        var line = self
        line.depositAmount = max(0, service.depositAmount)
        return line
    }
}

/// Editable state of the appointment editor.
struct AppointmentDraft: Identifiable, Hashable {
    static let defaultDurationMin = 60
    static let durationStep = 15
    static let defaultStartHour = 12
    /// Server limit of service lines per appointment.
    static let maxLines = 20

    let id = UUID()
    var appointmentId: Int?
    var client: ClientRef?
    var clientSuggestion: ClientSuggestion?
    /// Changing it re-prices the untouched catalog lines (`repriceLines(from:)`).
    var masterId: Int?
    /// The master of a saved appointment as loaded: its lines were priced for them.
    private(set) var savedMasterId: Int?
    /// Any booking change drops the kept total and lets an automatic duration follow the services
    /// (prepayment amounts resolved from the catalog are not a booking change).
    var lines: [DraftServiceLine] = [] {
        didSet {
            guard lines.map(\.body) != oldValue.map(\.body) else { return }
            priceOverride = nil
            recomputeDuration()
        }
    }
    var start: Date
    var durationMin: Int
    /// The last duration the draft set from its services; while `durationMin` equals it, the duration
    /// follows the services. `nil` (or any other value) means a duration set by hand or loaded as is.
    private(set) var autoDurationMin: Int?
    /// Manual price, used only while there are no service lines.
    var price = 0
    /// Total of a saved appointment whose price differs from its line sum (set by an older build, the
    /// server or an import); kept until the lines change or «Пересчитать по услугам».
    private(set) var priceOverride: Int?
    /// Prepayment set by hand (or a saved one that differs from the services); `nil` — follows the services.
    /// Kept when the services change, dropped by «Пересчитать по услугам».
    private(set) var depositOverride: Int?
    /// Prepayment held for a saved appointment (read-only here: it changes through the prepayment endpoints).
    private(set) var heldDeposit = 0
    var title = ""
    var notes = ""

    var isEditing: Bool { appointmentId != nil }
    var end: Date { start.addingTimeInterval(TimeInterval(durationMin * 60)) }

    /// Appointment total: the kept total or the sum of line prices, or the manual price when there are no lines.
    var total: Int { lines.isEmpty ? price : priceOverride ?? linesTotal }
    var linesTotal: Int { lines.reduce(0) { $0 + $1.price } }
    /// Sum of the lines' catalog prepayments (a service booked twice counts twice).
    var linesDeposit: Int { lines.reduce(0) { $0 + $1.depositAmount } }

    /// Prepayment the studio asks for: the services' sum until set by hand. Setting it back to the
    /// services' sum makes it follow them again.
    var depositRequired: Int {
        get { depositOverride ?? linesDeposit }
        set {
            let amount = max(0, newValue)
            depositOverride = amount == linesDeposit ? nil : amount
        }
    }
    /// Sum of line durations (lines without one count as 0).
    var linesDuration: Int { lines.reduce(0) { $0 + ($1.durationMin ?? 0) } }
    var canAddLine: Bool { lines.count < Self.maxLines }

    var isValid: Bool {
        client != nil && masterId != nil && durationMin > 0 && total >= 0 && depositRequired >= 0
            && lines.allSatisfy { $0.name.nonEmpty != nil && $0.price >= 0 }
    }

    static func new(
        day: Date,
        client: ClientRef? = nil,
        notes: String = "",
        suggestion: ClientSuggestion? = nil
    ) -> AppointmentDraft {
        // The default duration is a placeholder, so the first booked service replaces it.
        AppointmentDraft(
            client: client,
            clientSuggestion: suggestion,
            start: defaultStart(on: day),
            durationMin: defaultDurationMin,
            autoDurationMin: defaultDurationMin,
            notes: notes
        )
    }

    /// New appointment at a tapped calendar slot.
    static func new(at start: Date, masterId: Int?) -> AppointmentDraft {
        AppointmentDraft(
            masterId: masterId,
            start: start,
            durationMin: defaultDurationMin,
            autoDurationMin: defaultDurationMin
        )
    }

    /// Loads a saved appointment as is: its duration follows the services only if it equals their sum,
    /// and a price or prepayment that differs from the services is kept. `catalog` resolves the lines'
    /// prepayments and catalog prices (see `resolveCatalog(from:)` when it loads later).
    static func edit(_ appointment: Appointment, catalog: [Service] = []) -> AppointmentDraft {
        let lines = lines(of: appointment).map {
            $0.resolvingDeposit(from: catalog).resolvingAutoPrice(from: catalog, masterId: appointment.master.id)
        }
        let linesDuration = lines.reduce(0) { $0 + ($1.durationMin ?? 0) }
        let linesTotal = lines.reduce(0) { $0 + $1.price }
        let linesDeposit = lines.reduce(0) { $0 + $1.depositAmount }
        return AppointmentDraft(
            appointmentId: appointment.id,
            client: appointment.client,
            masterId: appointment.master.id,
            savedMasterId: appointment.master.id,
            lines: lines,
            start: appointment.startsAt,
            durationMin: max(durationStep, appointment.durationMin),
            autoDurationMin: linesDuration > 0 ? max(durationStep, linesDuration) : nil,
            price: appointment.price,
            priceOverride: lines.isEmpty || linesTotal == appointment.price ? nil : appointment.price,
            depositOverride: appointment.depositRequired == linesDeposit ? nil : appointment.depositRequired,
            heldDeposit: appointment.deposit,
            title: appointment.title ?? "",
            notes: appointment.notes ?? ""
        )
    }

    /// Service lines of a saved appointment; servers without `services` fall back to the legacy single
    /// `service`, which then carries the whole appointment price and duration.
    static func lines(of appointment: Appointment) -> [DraftServiceLine] {
        if !appointment.services.isEmpty {
            return appointment.services.map(DraftServiceLine.init(line:))
        }
        guard let service = appointment.service else { return [] }
        return [
            DraftServiceLine(
                serviceId: service.id,
                name: service.name,
                price: appointment.price,
                durationMin: appointment.durationMin,
                category: service.category
            ),
        ]
    }

    /// Next round hour today (if the studio is still open), otherwise noon on that day.
    static func defaultStart(on day: Date, now: Date = .now) -> Date {
        let calendar = Calendar.app
        if calendar.isDate(day, inSameDayAs: now) {
            let nextHour = calendar.component(.hour, from: now) + 1
            if nextHour < 21, let start = calendar.date(bySettingHour: nextHour, minute: 0, second: 0, of: day) {
                return start
            }
        }
        return calendar.date(bySettingHour: defaultStartHour, minute: 0, second: 0, of: day) ?? day
    }

    // MARK: - Service lines

    /// Number of lines booked from the catalog service.
    func lineCount(serviceId: Int) -> Int {
        lines.count(where: { $0.serviceId == serviceId })
    }

    /// The first line booked from the catalog service.
    func line(serviceId: Int) -> DraftServiceLine? {
        lines.first { $0.serviceId == serviceId }
    }

    mutating func add(service: Service, variant: ServiceVariant? = nil) {
        append(DraftServiceLine(service: service, variant: variant, masterId: masterId))
    }

    /// Adds a free-form line; blank names are ignored.
    mutating func addCustom(name: String, price: Int) {
        guard let name = name.nonEmpty else { return }
        append(DraftServiceLine(serviceId: nil, name: name, price: max(0, price), durationMin: nil))
    }

    /// Catalog toggle for a service without variants: removes its lines, or adds it.
    mutating func toggle(service: Service) {
        if lineCount(serviceId: service.id) > 0 {
            removeLines(serviceId: service.id)
        } else {
            add(service: service)
        }
    }

    /// Books the variant (or the plain service), replacing an already booked line of that service in place.
    mutating func select(service: Service, variant: ServiceVariant?) {
        guard let index = lines.firstIndex(where: { $0.serviceId == service.id }) else {
            add(service: service, variant: variant)
            return
        }
        lines[index] = DraftServiceLine(service: service, variant: variant, masterId: masterId)
    }

    mutating func removeLines(serviceId: Int) {
        lines.removeAll { $0.serviceId == serviceId }
    }

    mutating func remove(at offsets: IndexSet) {
        lines.remove(atOffsets: IndexSet(offsets.filter(lines.indices.contains)))
    }

    /// Drops the kept total of a saved appointment: the total becomes the sum of line prices.
    mutating func recalculateTotal() {
        priceOverride = nil
    }

    /// Drops the hand-set prepayment: it follows the services again.
    mutating func recalculateDeposit() {
        depositOverride = nil
    }

    /// Fills the prepayments of lines loaded from a saved appointment once the catalog is known; a kept
    /// prepayment that turns out to equal the services' sum follows them again.
    mutating func resolveDeposits(from catalog: [Service]) {
        lines = lines.map { $0.resolvingDeposit(from: catalog) }
        if depositOverride == linesDeposit {
            depositOverride = nil
        }
    }

    /// Once the catalog is known: the prepayments and the catalog prices of the lines loaded from a saved
    /// appointment (for its saved master), then the untouched lines take the current master's prices.
    mutating func resolveCatalog(from catalog: [Service]) {
        lines = lines.map { $0.resolvingAutoPrice(from: catalog, masterId: savedMasterId) }
        resolveDeposits(from: catalog)
        repriceLines(from: catalog)
    }

    /// The catalog lines nobody edited take the current master's prices (after the master changes, or when lines
    /// were added before a master was chosen). The total and the duration follow as with any change of the services;
    /// a hand-set price stays.
    mutating func repriceLines(from catalog: [Service]) {
        lines = lines.map { $0.repriced(for: masterId, catalog: catalog) }
    }

    private mutating func append(_ line: DraftServiceLine) {
        guard canAddLine else { return }
        lines.append(line)
    }

    /// Duration follows the booked services unless it was set by hand (differs from the last automatic value).
    private mutating func recomputeDuration() {
        let sum = linesDuration
        guard sum > 0, let autoDurationMin, durationMin == autoDurationMin else { return }
        durationMin = max(Self.durationStep, sum)
        self.autoDurationMin = durationMin
    }

    // MARK: - Request

    /// `services` is always sent (`[]` clears the lines), so the legacy `serviceId` is ignored by the server.
    func body(force: Bool) -> AppointmentBody? {
        guard let client, let masterId, isValid else { return nil }
        return AppointmentBody(
            clientId: client.id,
            masterId: masterId,
            services: lines.map(\.body),
            serviceId: nil,
            title: Nullable(title.nonEmpty),
            startsAt: start,
            endsAt: end,
            price: total,
            depositRequired: depositRequired,
            notes: Nullable(notes.nonEmpty),
            force: force ? true : nil
        )
    }
}
