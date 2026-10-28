import Foundation

/// `{ "items": [...] }`, plus `total` for paginated lists.
nonisolated struct ItemsResponse<Item: Decodable & Sendable>: Decodable, Sendable {
    let items: [Item]
    let total: Int?
}

nonisolated struct Badges: Codable, Hashable, Sendable {
    let unreadChats: Int
    let needsAttention: Int
    let newBookingRequests: Int
    let lowStock: Int
    /// SMM posts waiting for approval in the enabled profiles.
    var smmReview = 0

    static let zero = Badges(unreadChats: 0, needsAttention: 0, newBookingRequests: 0, lowStock: 0)
}

nonisolated extension Badges {
    private enum CodingKeys: String, CodingKey {
        case unreadChats, needsAttention, newBookingRequests, lowStock, smmReview
    }

    /// Servers without the SMM module send no `smmReview`.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            unreadChats: try c.decode(Int.self, forKey: .unreadChats),
            needsAttention: try c.decode(Int.self, forKey: .needsAttention),
            newBookingRequests: try c.decode(Int.self, forKey: .newBookingRequests),
            lowStock: try c.decode(Int.self, forKey: .lowStock),
            smmReview: try c.decode(.smmReview, or: 0)
        )
    }
}

nonisolated struct Dashboard: Codable, Sendable {
    /// `YYYY-MM-DD` in the studio time zone.
    let date: String
    let appointments: [Appointment]
    let revenueToday: Int
    let salesCountToday: Int
    let openShift: CashShift?
    let badges: Badges
}

nonisolated struct LoginResponse: Codable, Sendable {
    let token: String
    let employee: Employee
}

/// `{ "url": "..." }` — used by uploads and Telegram deep links.
nonisolated struct LinkResponse: Codable, Sendable {
    let url: String
}

nonisolated struct HealthResponse: Codable, Sendable {
    let ok: Bool
    let version: String?
}

nonisolated extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Trimmed value, or `nil` when blank.
    var nonEmpty: String? {
        let value = trimmed
        return value.isEmpty ? nil : value
    }
}

nonisolated extension Optional where Wrapped == String {
    /// Trimmed value, or `nil` when absent or blank.
    var nonEmpty: String? { self.flatMap(\.nonEmpty) }
}
