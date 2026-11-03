import Foundation

/// `WaitlistEntry.status` (docs/API.md «Waitlist»).
nonisolated enum WaitlistStatus: String, Codable, CaseIterable, Hashable, Sendable {
    /// Waits for freed time.
    case waiting
    /// Told in Telegram about freed time; stays open and may be told again later.
    case notified
    /// The client booked inside the range (`appointmentId`).
    case booked
    case cancelled
    /// `dateTo` passed.
    case expired

    /// Still waiting for time: may be cancelled, counts towards the badge and the 3-per-client limit.
    var isOpen: Bool { self == .waiting || self == .notified }
}

/// A wanted service: `name` is the service's, `variant` the chosen variant's name.
nonisolated struct WaitlistItem: Codable, Hashable, Sendable {
    let serviceId: Int
    let variant: String?
    let name: String

    /// «Мочка — Два», or «Мочка» without a variant.
    var title: String {
        guard let variant = variant.nonEmpty else { return name }
        return "\(name) — \(variant)"
    }
}

/// A client's wish for time that was taken: services, a master or any, a date range of at most 30 days.
nonisolated struct WaitlistEntry: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let client: ClientRef
    let items: [WaitlistItem]
    /// `nil` — any master.
    let master: EmployeeRef?
    /// Studio-local `YYYY-MM-DD`, inclusive.
    let dateFrom: String
    /// Studio-local `YYYY-MM-DD`, inclusive.
    let dateTo: String
    let status: WaitlistStatus
    /// Where the entry was made: `app` (staff), `bot`, `miniapp`, `web`.
    let channel: AppointmentChannel
    /// The last freed-time message.
    let notifiedAt: Date?
    /// The appointment that closed a `booked` entry.
    let appointmentId: Int?
    let note: String?
    let createdAt: Date
}

/// `POST /waitlist` item: a variant is required for a service with variants.
nonisolated struct WaitlistItemBody: Encodable, Hashable, Sendable {
    let serviceId: Int
    let variant: String?
}

/// `POST /waitlist`: `masterId` omitted — any master; `note` omitted when blank.
nonisolated struct WaitlistBody: Encodable, Equatable, Sendable {
    let clientId: Int
    let items: [WaitlistItemBody]
    let masterId: Int?
    let dateFrom: String
    let dateTo: String
    let note: String?
}

/// `PATCH /waitlist/:id`: staff only cancel.
nonisolated struct WaitlistStatusBody: Encodable, Equatable, Sendable {
    let status: WaitlistStatus
}
