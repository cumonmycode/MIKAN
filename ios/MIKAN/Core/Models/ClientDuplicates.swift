import Foundation

/// Why cards look like one person (docs/API.md «Clients» → «Duplicates»), strongest first.
nonisolated enum DuplicateReason: String, Codable, CaseIterable, Sendable {
    case sameTelegram = "same_telegram"
    case sameInstagram = "same_instagram"
    case sameFullName = "same_full_name"
    case phonelessSameName = "phoneless_same_name"
    /// A reason this build does not know yet (sent by a newer server).
    case other

    var title: String {
        switch self {
        case .sameTelegram: "Одинаковый Telegram"
        case .sameInstagram: "Одинаковый Instagram"
        case .sameFullName: "Одинаковые имя и фамилия"
        case .phonelessSameName: "То же имя, у карточки нет телефона"
        case .other: "Похожие карточки"
        }
    }

    var systemImage: String {
        switch self {
        case .sameTelegram: "paperplane"
        case .sameInstagram: "camera"
        case .sameFullName: "person.text.rectangle"
        case .phonelessSameName: "phone.badge.questionmark"
        case .other: "person.2"
        }
    }
}

nonisolated extension DuplicateReason {
    /// An unknown reason reads as `.other`, so a newer server never breaks the list.
    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = DuplicateReason(rawValue: raw) ?? .other
    }
}

/// Cards that are likely one person: shown side by side to merge or to mark as different people.
nonisolated struct DuplicateGroup: Codable, Hashable, Identifiable, Sendable {
    let reason: DuplicateReason
    /// With `stats`; the card with the most visits first.
    let clients: [Client]

    var id: String { "\(reason.rawValue):" + clients.map { String($0.id) }.joined(separator: ",") }
    var clientIds: [Int] { clients.map(\.id) }
}

nonisolated struct ClientMergeBody: Encodable, Sendable {
    let intoId: Int
}

nonisolated struct DuplicateDismissBody: Encodable, Sendable {
    let clientIds: [Int]
}

nonisolated extension Permissions {
    /// «Похожие карточки», «Это разные люди» and «Объединить с…»: owner and admin.
    var mergesClients: Bool { role != .master }
}
