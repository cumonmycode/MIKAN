import Foundation

nonisolated enum MessageRole: String, Codable, Sendable {
    /// Client
    case user
    /// AI
    case assistant
    /// Employee, sent from the app
    case staff
    /// Automatic: aftercare, reminders
    case system
}

nonisolated struct BotMessage: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let chatId: Int64
    let role: MessageRole
    let text: String
    let employee: EmployeeRef?
    let createdAt: Date
}

nonisolated struct BotChat: Codable, Hashable, Identifiable, Sendable {
    let chatId: Int64
    var client: ClientRef?
    var telegramName: String?
    var username: String?
    var aiPaused: Bool
    var needsAttention: Bool
    var unreadCount: Int
    var lastMessage: BotMessage?
    var updatedAt: Date
    /// The employee whose phone matched the contact shared in this chat, or whom staff bound to it in the app
    /// («Это сотрудник…»): the bot answers them as the studio's assistant (appointments, clients, analytics, stock).
    /// `nil` for client chats and on older servers.
    var employee: EmployeeRef?

    var id: Int64 { chatId }

    var isStaff: Bool { employee != nil }

    var displayName: String {
        employee?.name ?? client?.fullName ?? telegramName.nonEmpty ?? username.nonEmpty.map { "@\($0)" } ?? "Без имени"
    }
}

/// `GET /clients/:id/chat`.
nonisolated struct ClientChatResponse: Codable, Sendable {
    let chat: BotChat?
}

nonisolated enum ScheduledKind: String, Codable, Sendable {
    case aftercare
    case reminder
    /// «Как заживает?» some days after the visit.
    case healingCheck = "healing_check"
    /// A jewelry change suggested some weeks after the visit.
    case jewelryChange = "jewelry_change"
    /// «Ваша запись перенесена»: staff moved the appointment and asked to tell the client.
    case rescheduleNotice = "reschedule_notice"
    /// A kind this build does not know yet (sent by a newer server); never sent by the app.
    case other

    /// Badge of the queued message.
    var title: String {
        switch self {
        case .aftercare: "Уход"
        case .reminder: "Напоминание"
        case .healingCheck: "Вопрос о заживлении"
        case .jewelryChange: "Замена украшения"
        case .rescheduleNotice: "Перенос записи"
        case .other: "Сообщение"
        }
    }
}

nonisolated extension ScheduledKind {
    /// An unknown kind reads as `.other`, so a newer server never breaks the queue.
    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ScheduledKind(rawValue: raw) ?? .other
    }
}

nonisolated enum ScheduledStatus: String, Codable, CaseIterable, Sendable {
    case pending
    case sent
    case failed
    case cancelled
}

nonisolated struct ScheduledMessage: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let chatId: Int64
    let client: ClientRef?
    let appointmentId: Int?
    let kind: ScheduledKind
    let sendAt: Date
    let text: String
    let status: ScheduledStatus
    let sentAt: Date?
    let error: String?
}

nonisolated enum BookingStatus: String, Codable, CaseIterable, Identifiable, Sendable {
    case new
    case processed
    case rejected

    var id: String { rawValue }
}

nonisolated struct BookingRequest: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let chatId: Int64?
    let client: ClientRef?
    let contactName: String?
    let phone: String?
    let serviceName: String?
    let preferredTime: String?
    let comment: String?
    let status: BookingStatus
    let createdAt: Date
    let updatedAt: Date

    var displayName: String { client?.fullName ?? contactName.nonEmpty ?? "Без имени" }
}

nonisolated struct KnowledgeEntry: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    var title: String
    var content: String
    var active: Bool
    var sort: Int
    let updatedAt: Date
}

nonisolated struct StaffCode: Codable, Sendable {
    let code: String
    let expiresAt: Date
    let instruction: String
}

nonisolated struct BotTestReply: Codable, Sendable {
    let reply: String
}
