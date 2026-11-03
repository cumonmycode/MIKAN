import Foundation

// MARK: - Payroll (docs/API.md «Payroll»)

extension APIClient {
    /// The owner gets every employee's statement, anyone else only their own. `from`/`to` are studio dates, inclusive.
    func payroll(from: String, to: String) async throws -> PayrollList {
        try await request(.get, "payroll", query: queryItems(["from": from, "to": to]))
    }

    /// The statement with its lines and adjustments.
    func payrollStatement(employeeId: Int, from: String, to: String) async throws -> PayrollStatement {
        try await request(.get, "payroll/\(employeeId)", query: queryItems(["from": from, "to": to]))
    }

    func payRules(employeeId: Int) async throws -> PayRulesResponse {
        try await request(.get, "employees/\(employeeId)/pay-rules")
    }

    /// Saves a version from `effectiveFrom`; the same date replaces that version.
    func savePayRules(employeeId: Int, _ body: PayRulesBody) async throws -> PayRulesResponse {
        try await request(.put, "employees/\(employeeId)/pay-rules", body: body)
    }

    func addPayrollAdjustment(_ body: PayrollAdjustmentBody, idempotencyKey: UUID) async throws -> PayrollAdjustment {
        try await request(.post, "payroll/adjustments", body: body, idempotencyKey: idempotencyKey)
    }

    func deletePayrollAdjustment(id: Int) async throws {
        try await requestVoid(.delete, "payroll/adjustments/\(id)")
    }
}

/// `PUT /employees/:id/pay-rules`: the rules flattened next to `effectiveFrom`.
nonisolated struct PayRulesBody: Encodable, Hashable, Sendable {
    let effectiveFrom: String
    let rules: PayRules

    private enum CodingKeys: String, CodingKey {
        case effectiveFrom, salaryMonthly, perDay, servicePercent, categoryPercent, productPercent, deductMaterials
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(effectiveFrom, forKey: .effectiveFrom)
        try c.encode(rules.salaryMonthly, forKey: .salaryMonthly)
        try c.encode(rules.perDay, forKey: .perDay)
        try c.encode(rules.servicePercent, forKey: .servicePercent)
        try c.encode(rules.categoryPercent, forKey: .categoryPercent)
        try c.encode(rules.productPercent, forKey: .productPercent)
        try c.encode(rules.deductMaterials, forKey: .deductMaterials)
    }
}

nonisolated struct PayrollAdjustmentBody: Encodable, Hashable, Sendable {
    let employeeId: Int
    let date: String
    let kind: PayrollAdjustmentKind
    let amount: Int
    let note: String?
    let fromCash: Bool
}
