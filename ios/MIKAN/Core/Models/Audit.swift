import Foundation

/// A line of the audit log («Журнал действий»): who changed what, and when (docs/API.md «AuditEntry»).
/// `changes` is not decoded: the app shows only `summary`, and an odd `changes` value must never break the list.
nonisolated struct AuditEntry: Decodable, Hashable, Identifiable, Sendable {
    let id: Int
    let at: Date
    /// `nil` for `bot` and `system` entries.
    let employee: EmployeeRef?
    let source: AuditSource
    /// E.g. `appointment.update`.
    let action: String
    /// Raw `entity` (see `AuditSection`): a newer server may send one this build does not know.
    let entity: String
    let entityId: Int?
    /// Russian, impersonal, written for people: «Запись №1846 (Анна Иванова) перенесена…».
    let summary: String
}

/// Where a change came from.
nonisolated enum AuditSource: String, Decodable, Hashable, Sendable {
    /// An employee in the app.
    case app
    /// An employee through the Telegram bot.
    case botStaff = "bot_staff"
    /// A client through the bot.
    case bot
    /// A client on the booking page or in the Mini App.
    case online
    /// The server by itself: automatic prepayment retain, a QR payment confirmed by the bank, a released online hold.
    case system
    /// A source this build does not know yet (sent by a newer server).
    case other
}

nonisolated extension AuditSource {
    /// An unknown source reads as `.other`, so a newer server never breaks the log.
    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AuditSource(rawValue: raw) ?? .other
    }
}

/// The log's «section» filter: an audit `entity` with its Russian title.
nonisolated enum AuditSection: String, CaseIterable, Identifiable, Hashable, Sendable {
    case appointment, deposit, sale, receipt, cash, client, service, product, stock
    case category, aftercare, knowledge, employee, schedule, payroll, settings, bot
    case campaign, certificate, waitlist, portfolio

    var id: String { rawValue }

    var title: String {
        switch self {
        case .appointment: "Записи"
        case .deposit: "Предоплаты"
        case .sale: "Продажи"
        case .receipt: "Открытые чеки"
        case .cash: "Касса"
        case .client: "Клиенты"
        case .service: "Услуги"
        case .product: "Товары"
        case .stock: "Склад"
        case .category: "Категории"
        case .aftercare: "Памятки"
        case .knowledge: "База знаний"
        case .employee: "Сотрудники"
        case .schedule: "Графики"
        case .payroll: "Зарплата"
        case .settings: "Настройки"
        case .bot: "Бот"
        case .campaign: "Рассылки"
        case .certificate: "Сертификаты"
        case .waitlist: "Лист ожидания"
        case .portfolio: "Портфолио"
        }
    }

    var symbol: String {
        switch self {
        case .appointment: "calendar"
        case .deposit: "banknote"
        case .sale: "cart"
        case .receipt: "doc.text"
        case .cash: "rublesign.circle"
        case .client: "person.2"
        case .service: "sparkles"
        case .product: "tag"
        case .stock: "shippingbox"
        case .category: "folder"
        case .aftercare: "cross.case"
        case .knowledge: "books.vertical"
        case .employee: "person.3"
        case .schedule: "calendar.badge.clock"
        case .payroll: "creditcard"
        case .settings: "gearshape"
        case .bot: "bubble.left.and.bubble.right"
        case .campaign: "megaphone"
        case .certificate: "gift"
        case .waitlist: "hourglass"
        case .portfolio: "photo.on.rectangle.angled"
        }
    }
}
