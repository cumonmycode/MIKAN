import Foundation

nonisolated enum AppointmentStatus: String, Codable, CaseIterable, Sendable {
    case scheduled
    case confirmed
    case completed
    case cancelled
    case noShow = "no_show"
}

nonisolated struct Appointment: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    var client: ClientRef
    var master: EmployeeRef
    /// Legacy single service: the catalog service of the first line that has one.
    var service: ServiceRef?
    /// Booked service lines in order (snapshots of name / price / duration).
    var services: [AppointmentServiceLine] = []
    var title: String?
    var startsAt: Date
    var endsAt: Date
    var status: AppointmentStatus
    var price: Int
    /// Prepayment held for the appointment right now (received − applied + returned by sale refunds − refunded − retained).
    var deposit: Int
    /// Prepayment the studio asks for (defaults to the services' `depositAmount`).
    var depositRequired = 0
    var depositStatus: DepositStatus = .none
    /// Prepayment ledger, oldest first.
    var depositOperations: [DepositOperation] = []
    /// The latest SBP QR code issued for this appointment's prepayment (any status).
    var depositLink: QrPayment?
    var notes: String?
    var saleId: Int?
    /// Its open receipt in the POS (the visit has started); `nil` when none or from an older server.
    var receiptId: Int? = nil
    var completedAt: Date?
    let createdAt: Date
    var updatedAt: Date
    /// What the studio's cancellation rules mean for it; `nil` without a prepayment or from an older server.
    var cancellation: AppointmentCancellation? = nil
    /// Where it was booked; `.app` from an older server.
    var channel: AppointmentChannel = .app
    /// An online booking the studio has not settled yet; `nil` once settled, for staff bookings and older servers.
    var onlineState: OnlineBookingState? = nil
    /// Until when the time is held for the client to pay the prepayment (`awaitingPayment`).
    var holdUntil: Date? = nil

    /// Service names, falling back to the free-form title.
    var displayTitle: String { serviceNames ?? service?.name ?? title.nonEmpty ?? "Запись" }

    /// «Хеликс, Мочка» — `nil` when no service lines.
    var serviceNames: String? {
        services.isEmpty ? nil : services.map(\.name).joined(separator: ", ")
    }

    var durationMin: Int { max(0, Int(endsAt.timeIntervalSince(startsAt) / 60)) }

    /// Paid: a sale is linked.
    var isPaid: Bool { saleId != nil }

    /// Not paid yet and its receipt is open in the POS.
    var isInPOS: Bool { !isPaid && receiptId != nil }

    /// Not cancelled and not a no-show.
    var isActive: Bool { status != .cancelled && status != .noShow }

    /// Can still be confirmed, completed, rescheduled or cancelled.
    var isOpen: Bool { status == .scheduled || status == .confirmed }

    /// An online booking still waiting for staff or for the client's prepayment (and not cancelled meanwhile).
    var isUnsettledOnline: Bool { onlineState != nil && isOpen }
}

nonisolated extension Appointment {
    private enum CodingKeys: String, CodingKey {
        case id, client, master, service, services, title, startsAt, endsAt, status, price, deposit, notes
        case depositRequired, depositStatus, depositOperations, depositLink
        case saleId, receiptId, completedAt, createdAt, updatedAt, cancellation
        case channel, onlineState, holdUntil
    }

    /// Tolerates servers that predate multi-service appointments (no `services`), prepayments (no `deposit…`),
    /// open receipts (no `receiptId`), cancellation rules (no `cancellation`) and online booking (no `channel`,
    /// `onlineState`, `holdUntil`); an `onlineState` this build does not know reads as settled.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        client = try c.decode(ClientRef.self, forKey: .client)
        master = try c.decode(EmployeeRef.self, forKey: .master)
        service = try c.decodeIfPresent(ServiceRef.self, forKey: .service)
        services = try c.decodeIfPresent([AppointmentServiceLine].self, forKey: .services) ?? []
        title = try c.decodeIfPresent(String.self, forKey: .title)
        startsAt = try c.decode(Date.self, forKey: .startsAt)
        endsAt = try c.decode(Date.self, forKey: .endsAt)
        status = try c.decode(AppointmentStatus.self, forKey: .status)
        price = try c.decode(Int.self, forKey: .price)
        deposit = try c.decode(Int.self, forKey: .deposit)
        depositRequired = try c.decodeIfPresent(Int.self, forKey: .depositRequired) ?? 0
        depositStatus = try c.decodeIfPresent(DepositStatus.self, forKey: .depositStatus) ?? .none
        depositOperations = try c.decodeIfPresent([DepositOperation].self, forKey: .depositOperations) ?? []
        depositLink = try c.decodeIfPresent(QrPayment.self, forKey: .depositLink)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        saleId = try c.decodeIfPresent(Int.self, forKey: .saleId)
        receiptId = try c.decodeIfPresent(Int.self, forKey: .receiptId)
        completedAt = try c.decodeIfPresent(Date.self, forKey: .completedAt)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        cancellation = try c.decodeIfPresent(AppointmentCancellation.self, forKey: .cancellation)
        channel = try c.decodeIfPresent(AppointmentChannel.self, forKey: .channel) ?? .app
        onlineState = try c.decodeIfPresent(String.self, forKey: .onlineState).flatMap(OnlineBookingState.init(rawValue:))
        holdUntil = try c.decodeIfPresent(Date.self, forKey: .holdUntil)
    }
}

/// `Appointment.cancellation`, counted from the held prepayment (the required one while nothing is held).
nonisolated struct AppointmentCancellation: Codable, Hashable, Sendable {
    /// The last moment a free cancellation is possible; `nil` when the studio never makes it free.
    let freeUntil: Date?
    /// Rubles kept after a later cancellation.
    let lateRetain: Int
    /// Rubles kept after a no-show.
    let noShowRetain: Int
}

/// One booked service of an appointment. `serviceId` is `nil` for a custom line.
nonisolated struct AppointmentServiceLine: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let serviceId: Int?
    let name: String
    let category: ServiceCategory?
    let price: Int
    let durationMin: Int?
}

nonisolated struct CompleteAppointmentResult: Codable, Sendable {
    let appointment: Appointment
    let scheduledMessages: Int
    /// What was taken from the stock; empty from a server that predates consumption norms.
    var consumption = Consumption()
}

nonisolated extension CompleteAppointmentResult {
    private enum CodingKeys: String, CodingKey { case appointment, scheduledMessages, consumption }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        appointment = try c.decode(Appointment.self, forKey: .appointment)
        scheduledMessages = try c.decode(Int.self, forKey: .scheduledMessages)
        consumption = try c.decodeIfPresent(Consumption.self, forKey: .consumption) ?? Consumption()
    }
}
