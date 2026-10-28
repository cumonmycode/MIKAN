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
    /// Future online bookings waiting for staff confirmation; 0 from a server without online booking.
    var onlineAwaiting = 0
    /// Open waitlist entries (`waiting` + `notified`); 0 from a server without the waitlist.
    var waitlist = 0
    /// SMM posts waiting for approval in the enabled profiles; 0 from a server without the SMM module.
    var smmReview = 0

    static let zero = Badges(unreadChats: 0, needsAttention: 0, newBookingRequests: 0, lowStock: 0)

    /// The «Ещё» tab: the sum of its rows' badges — unread chats, new booking requests, online bookings to confirm,
    /// the open waitlist and SMM posts to approve (low stock is on «Склад»).
    var moreTab: Int { unreadChats + newBookingRequests + onlineAwaiting + waitlist + smmReview }
}

nonisolated extension Badges {
    private enum CodingKeys: String, CodingKey {
        case unreadChats, needsAttention, newBookingRequests, lowStock, onlineAwaiting, waitlist, smmReview
    }

    /// Tolerates servers that predate online booking (no `onlineAwaiting`), the waitlist (no `waitlist`) or the SMM
    /// module (no `smmReview`).
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        unreadChats = try c.decode(Int.self, forKey: .unreadChats)
        needsAttention = try c.decode(Int.self, forKey: .needsAttention)
        newBookingRequests = try c.decode(Int.self, forKey: .newBookingRequests)
        lowStock = try c.decode(Int.self, forKey: .lowStock)
        onlineAwaiting = try c.decodeIfPresent(Int.self, forKey: .onlineAwaiting) ?? 0
        waitlist = try c.decodeIfPresent(Int.self, forKey: .waitlist) ?? 0
        smmReview = try c.decodeIfPresent(Int.self, forKey: .smmReview) ?? 0
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
