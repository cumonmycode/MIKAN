import Foundation

// MARK: - Expenses (docs/API.md «Expenses»)

extension APIClient {
    /// Monthly ones first, then one-time ones; newest first in each.
    func expenses() async throws -> [StudioExpense] {
        let response: ItemsResponse<StudioExpense> = try await request(.get, "expenses")
        return response.items
    }

    func addExpense(_ body: ExpenseBody, idempotencyKey: UUID) async throws -> StudioExpense {
        try await request(.post, "expenses", body: body, idempotencyKey: idempotencyKey)
    }

    func updateExpense(id: Int, _ body: ExpenseBody) async throws -> StudioExpense {
        try await request(.patch, "expenses/\(id)", body: body)
    }

    func deleteExpense(id: Int) async throws {
        try await requestVoid(.delete, "expenses/\(id)")
    }
}
