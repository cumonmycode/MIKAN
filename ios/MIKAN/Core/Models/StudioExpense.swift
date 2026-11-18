import Foundation

/// `Expense` (docs/API.md «Expenses»): rent, electricity and other bills every month, or a one-time purchase.
nonisolated struct StudioExpense: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let name: String
    let category: ExpenseCategory
    let amount: Int
    let repeatKind: ExpenseRepeat
    /// `YYYY-MM-DD`: the purchase date, or the first month of a monthly expense (charged on this day).
    let date: String
    /// `YYYY-MM-DD`, inclusive: the last date a monthly expense is charged; `nil` — still charged.
    let endDate: String?
    let note: String?
    let createdBy: EmployeeRef?

    private enum CodingKeys: String, CodingKey {
        case id, name, category, amount, repeatKind = "repeat", date, endDate, note, createdBy
    }

    /// A monthly expense whose end date has passed.
    func isEnded(today: String) -> Bool {
        repeatKind == .monthly && endDate.map { $0 < today } == true
    }
}

nonisolated enum ExpenseRepeat: String, Codable, CaseIterable, Identifiable, Sendable {
    case monthly, once

    var id: String { rawValue }

    var title: String {
        switch self {
        case .monthly: "Каждый месяц"
        case .once: "Разовый"
        }
    }
}

nonisolated enum ExpenseCategory: String, CaseIterable, Identifiable, Sendable {
    case rent, utilities, internet, furniture, repair, marketing, other

    var id: String { rawValue }

    var title: String {
        switch self {
        case .rent: "Аренда"
        case .utilities: "Свет, вода, коммуналка"
        case .internet: "Связь и интернет"
        case .furniture: "Мебель и оборудование"
        case .repair: "Ремонт"
        case .marketing: "Реклама"
        case .other: "Другое"
        }
    }

    var systemImage: String {
        switch self {
        case .rent: "building.2"
        case .utilities: "lightbulb"
        case .internet: "wifi"
        case .furniture: "cabinet"
        case .repair: "hammer"
        case .marketing: "megaphone"
        case .other: "ellipsis.circle"
        }
    }
}

nonisolated extension ExpenseCategory: Codable {
    /// A category added by a newer server reads as «Другое».
    init(from decoder: any Decoder) throws {
        self = ExpenseCategory(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
    }
}

/// `POST /expenses` and `PATCH /expenses/:id`: every field, `endDate` and `note` as `null` when cleared.
nonisolated struct ExpenseBody: Encodable, Hashable, Sendable {
    let name: String
    let category: ExpenseCategory
    let amount: Int
    let repeatKind: ExpenseRepeat
    let date: String
    let endDate: String?
    let note: String?

    private enum CodingKeys: String, CodingKey {
        case name, category, amount, repeatKind = "repeat", date, endDate, note
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(category, forKey: .category)
        try c.encode(amount, forKey: .amount)
        try c.encode(repeatKind, forKey: .repeatKind)
        try c.encode(date, forKey: .date)
        try c.encode(endDate, forKey: .endDate)
        try c.encode(note, forKey: .note)
    }
}

/// `expenses` of the analytics: studio expenses charged in the period.
nonisolated struct AnalyticsExpenses: Decodable, Hashable, Sendable {
    var total = 0
    var monthly = 0
    var once = 0
    var byCategory: [CategoryAmount] = []
    var items: [Item] = []

    nonisolated struct CategoryAmount: Decodable, Hashable, Identifiable, Sendable {
        let category: ExpenseCategory
        let amount: Int

        var id: String { category.rawValue }
    }

    nonisolated struct Item: Decodable, Hashable, Identifiable, Sendable {
        let id: Int
        let name: String
        let category: ExpenseCategory
        let repeatKind: ExpenseRepeat
        /// How many times it was charged in the period (a monthly one once per month).
        let times: Int
        let amount: Int

        private enum CodingKeys: String, CodingKey {
            case id, name, category, repeatKind = "repeat", times, amount
        }
    }
}
