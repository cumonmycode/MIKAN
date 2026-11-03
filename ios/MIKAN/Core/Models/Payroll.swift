import Foundation

/// How an employee is paid (docs/API.md «PayRules»). Percents are 0…100, money is whole rubles.
nonisolated struct PayRules: Codable, Hashable, Sendable {
    var salaryMonthly = 0
    var perDay = 0
    var servicePercent: Double = 0
    var categoryPercent = CategoryPercents()
    var productPercent: Double = 0
    var deductMaterials = false

    /// Percent of a service category: its own override, else `servicePercent`.
    func percent(for category: ServiceCategory) -> Double {
        categoryPercent[category] ?? servicePercent
    }
}

/// Per-category overrides of `servicePercent`; `nil` = the general percent.
nonisolated struct CategoryPercents: Codable, Hashable, Sendable {
    var tattoo: Double?
    var piercing: Double?
    var other: Double?

    subscript(category: ServiceCategory) -> Double? {
        get {
            switch category {
            case .tattoo: tattoo
            case .piercing: piercing
            case .other: other
            }
        }
        set {
            switch category {
            case .tattoo: tattoo = newValue
            case .piercing: piercing = newValue
            case .other: other = newValue
            }
        }
    }
}

/// One version of the rules: in force from `effectiveFrom` (a studio date) until the next one.
nonisolated struct PayRulesVersion: Codable, Hashable, Identifiable, Sendable {
    let effectiveFrom: String
    let rules: PayRules
    let createdBy: EmployeeRef?
    let createdAt: Date

    var id: String { effectiveFrom }
}

/// `GET /employees/:id/pay-rules`: the version in force today (`nil` before the first) and every version, newest first.
nonisolated struct PayRulesResponse: Codable, Hashable, Sendable {
    let current: PayRules?
    let history: [PayRulesVersion]
}

/// A calculated pay statement of one employee for a period (docs/API.md «PayrollStatement»).
nonisolated struct PayrollStatement: Codable, Hashable, Identifiable, Sendable {
    let employee: EmployeeRef
    let from: String
    let to: String
    let services: Services
    let products: Products
    let salary: Int
    let days: Int
    let perDay: Int
    let adjustments: AdjustmentTotals
    let earned: Int
    let paid: Int
    let due: Int
    /// Only in the detailed statement (`GET /payroll/:employeeId`).
    var lines: [PayrollLine]?
    var adjustmentItems: [PayrollAdjustment]?

    var id: Int { employee.id }

    nonisolated struct Services: Codable, Hashable, Sendable {
        let visits: Int
        let revenue: Int
        let materials: Int
        let amount: Int
    }

    nonisolated struct Products: Codable, Hashable, Sendable {
        let revenue: Int
        let amount: Int
    }

    nonisolated struct AdjustmentTotals: Codable, Hashable, Sendable {
        let bonus: Int
        let penalty: Int
        let advance: Int
        let payout: Int
    }
}

/// A service or product line the percent was counted from.
nonisolated struct PayrollLine: Codable, Hashable, Sendable {
    let date: String
    /// `service` | `product`.
    let kind: String
    let appointmentId: Int?
    let saleId: Int
    let name: String
    /// `tattoo` | `piercing` | `other` for services, `nil` for products.
    let category: String?
    let revenue: Int
    let materials: Int
    let percent: Double
    let amount: Int

    var isService: Bool { kind == "service" }
}

nonisolated struct PayrollList: Codable, Hashable, Sendable {
    let from: String
    let to: String
    let items: [PayrollStatement]
}

/// A manual entry: a bonus or a penalty changes the pay, an advance or a payout pays it out.
nonisolated struct PayrollAdjustment: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let employee: EmployeeRef
    let date: String
    let kind: PayrollAdjustmentKind
    let amount: Int
    let note: String?
    let cashOperationId: Int?
    let createdBy: EmployeeRef?
    let createdAt: Date
}

nonisolated enum PayrollAdjustmentKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case bonus, penalty, advance, payout

    var id: String { rawValue }

    var title: String {
        switch self {
        case .bonus: "Премия"
        case .penalty: "Штраф"
        case .advance: "Аванс"
        case .payout: "Выплата"
        }
    }

    var systemImage: String {
        switch self {
        case .bonus: "gift"
        case .penalty: "exclamationmark.triangle"
        case .advance: "banknote"
        case .payout: "checkmark.seal"
        }
    }

    /// Advances and payouts hand money over (and may come from the till); bonuses and penalties change the pay.
    var isPayment: Bool { self == .advance || self == .payout }
}
