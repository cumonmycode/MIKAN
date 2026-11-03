import Foundation

/// A photo of a master's work (docs/API.md «Portfolio»). Clients see it at online booking; the bot sends it on request.
nonisolated struct PortfolioPhoto: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let employee: EmployeeRef
    /// Server-relative path from `POST /uploads`.
    let imageUrl: String
    let caption: String?
    /// The service the work shows; `nil` — not tied to a service.
    let service: ServiceRef?
    let sort: Int
    let createdAt: Date
}

/// `POST /portfolio`: a photo uploaded with `POST /uploads`, appended after the master's other photos.
nonisolated struct PortfolioPhotoBody: Encodable, Hashable, Sendable {
    let employeeId: Int
    let imageUrl: String
    var serviceId: Int?
    var caption: String?
}

/// `PATCH /portfolio/:id`. Both keys are always sent: `null` clears the caption or unties the service.
nonisolated struct PortfolioPhotoPatch: Encodable, Hashable, Sendable {
    let caption: Nullable<String>
    let serviceId: Nullable<Int>
}

nonisolated extension PortfolioPhotoPatch {
    /// A blank caption is sent as `null`.
    init(caption: String, serviceId: Int?) {
        self.init(caption: Nullable(caption.nonEmpty), serviceId: Nullable(serviceId))
    }
}

/// `PUT /portfolio/order`: every photo id of the master, in the new order.
nonisolated struct PortfolioOrderBody: Encodable, Hashable, Sendable {
    let employeeId: Int
    let ids: [Int]
}
