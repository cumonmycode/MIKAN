import Foundation

nonisolated struct Client: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    /// First name (older cards may hold the full name here).
    var name: String
    var lastName: String? = nil
    /// Required for new clients; cards imported from YCLIENTS may have none.
    var phone: String?
    var instagram: String?
    /// Telegram username typed by staff, without "@". `telegramUsername` comes from the linked bot chat.
    var telegramNick: String? = nil
    /// Calendar date `YYYY-MM-DD`.
    var birthday: String?
    var notes: String?
    var source: String?
    var telegramLinked: Bool
    var telegramUsername: String?
    var botEnabled: Bool
    /// The client asked for no news and offers (campaigns, birthday, win-back); `nil` from a server without campaigns.
    var marketingOptOut: Bool? = nil
    var archived: Bool
    let createdAt: Date
    var updatedAt: Date
    /// `nil` in lists, filled by `GET /clients/:id`.
    var stats: ClientStats?
    /// Bonuses and the birthday discount; `nil` in lists and from a server without loyalty.
    var loyalty: ClientLoyalty? = nil

    var ref: ClientRef { ClientRef(id: id, name: name, lastName: lastName, phone: phone, telegramLinked: telegramLinked) }
    /// "Иван Петров" — how the app names the client everywhere.
    var fullName: String { PersonName.full(name, lastName) }
    /// The nick typed by staff, else the username of the linked bot chat.
    var telegramHandle: String? { telegramNick.nonEmpty ?? telegramUsername.nonEmpty }
}

nonisolated struct ClientStats: Codable, Hashable, Sendable {
    let visits: Int
    let totalSpent: Int
    let lastVisitAt: Date?
    let upcomingAppointments: Int
}

/// Embedded client summary used inside other entities.
nonisolated struct ClientRef: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let name: String
    var lastName: String? = nil
    let phone: String?
    let telegramLinked: Bool

    var fullName: String { PersonName.full(name, lastName) }
}

/// A person's name split into first and last name, as the client card stores it.
nonisolated enum PersonName {
    /// "Иван" + "Петров" → "Иван Петров"; blank parts are skipped.
    static func full(_ first: String, _ last: String?) -> String {
        [first, last ?? ""]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    /// "Анна Смирнова" → ("Анна", "Смирнова"): the first word is the first name, the rest the last name.
    /// Used to prefill the card from a name typed in one line (e.g. a booking request from the bot).
    static func split(_ text: String) -> (first: String, last: String) {
        let words = text.split(whereSeparator: \.isWhitespace)
        guard let first = words.first else { return ("", "") }
        return (String(first), words.dropFirst().joined(separator: " "))
    }
}

nonisolated struct ClientHistory: Codable, Sendable {
    /// Services done and products bought, newest first.
    var items: [HistoryEntry] = []
    let appointments: [Appointment]
    let sales: [Sale]
}

nonisolated extension ClientHistory {
    private enum CodingKeys: String, CodingKey { case items, appointments, sales }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([HistoryEntry].self, forKey: .items) ?? []
        appointments = try c.decode([Appointment].self, forKey: .appointments)
        sales = try c.decode([Sale].self, forKey: .sales)
    }
}

nonisolated enum HistoryEntryKind: String, Codable, Sendable {
    case service
    case product
}

/// One thing done for or sold to a client: a service line of a completed appointment, or a sale item.
nonisolated struct HistoryEntry: Codable, Hashable, Identifiable, Sendable {
    /// `as<line>`, `at<appointment>` or `si<sale item>`.
    let id: String
    let kind: HistoryEntryKind
    let date: Date
    let name: String
    let serviceId: Int?
    let productId: Int?
    /// The size sold (product entries).
    var variantId: Int? = nil
    var variantName: String? = nil
    let quantity: Int
    let price: Int
    let total: Int
    let client: ClientRef?
    /// Master (services) or seller (products).
    let employee: EmployeeRef?
    let appointmentId: Int?
    let saleId: Int?
    let saleNumber: Int?
    let refunded: Bool
}

/// Suggested `source` values. The field itself is free text.
nonisolated enum ClientSource {
    static let suggestions = ["instagram", "telegram", "рекомендация", "с улицы", "другое"]

    static func title(for source: String) -> String {
        switch source {
        case "instagram": "Instagram"
        case "telegram": "Telegram"
        default: source.prefix(1).uppercased() + source.dropFirst()
        }
    }
}
