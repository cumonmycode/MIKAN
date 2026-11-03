import Foundation

/// The screen a tapped push notification opens (docs/API.md «Push notifications», `data.type`).
nonisolated enum PushRoute: Hashable, Identifiable, Sendable {
    /// `online_booking`, `deposit_paid`, `client_cancelled`.
    case appointment(id: Int)
    /// `client_message`: the client's bot chat (Telegram chat id).
    case chat(chatId: Int64)
    /// `booking_request`.
    case bookingRequests
    /// `online_booking` without an appointment id.
    case onlineBookings

    var id: String {
        switch self {
        case .appointment(let id): "appointment-\(id)"
        case .chat(let chatId): "chat-\(chatId)"
        case .bookingRequests: "booking-requests"
        case .onlineBookings: "online-bookings"
        }
    }
}

nonisolated extension PushRoute {
    /// Reads the notification's `userInfo`. The event fields may sit at the top level next to `aps` or inside a
    /// `data` dictionary; ids may come as numbers or strings. `nil` — an event this build does not route.
    init?(userInfo: [AnyHashable: Any]) {
        let data = (userInfo["data"] as? [AnyHashable: Any]) ?? userInfo
        guard let type = data["type"] as? String else { return nil }
        switch type {
        case "online_booking":
            self = Self.number(data["appointmentId"]).map { .appointment(id: Int($0)) } ?? .onlineBookings
        case "deposit_paid", "client_cancelled":
            guard let id = Self.number(data["appointmentId"]) else { return nil }
            self = .appointment(id: Int(id))
        case "client_message":
            guard let chatId = Self.number(data["chatId"]) else { return nil }
            self = .chat(chatId: chatId)
        case "booking_request":
            self = .bookingRequests
        default:
            return nil
        }
    }

    /// An integer id sent as a JSON number or a string.
    private static func number(_ value: Any?) -> Int64? {
        switch value {
        case let number as NSNumber:
            // A Bool is an NSNumber too; it is never an id.
            guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
            let id = number.int64Value
            return Double(id) == number.doubleValue ? id : nil
        case let text as String:
            return Int64(text.trimmed)
        default:
            return nil
        }
    }
}
