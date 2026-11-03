import Foundation

// MARK: - Work schedules of masters (docs/API.md «Work schedules»)

extension APIClient {
    /// Every active master × every studio date from `from` to `to` (inclusive, ≤ 62 days).
    func schedules(from: String, to: String) async throws -> [ScheduleDay] {
        let response: ItemsResponse<ScheduleDay> = try await request(
            .get, "schedules",
            query: queryItems(["from": from, "to": to])
        )
        return response.items
    }

    /// The weekly schedule and the exceptions from today (or from `from`) on.
    func workSchedule(employeeId: Int, from: String? = nil) async throws -> WorkSchedule {
        try await request(.get, "employees/\(employeeId)/schedule", query: queryItems(["from": from]))
    }

    func saveWeeklySchedule(employeeId: Int, weekly: [WorkHours?]?) async throws -> WorkSchedule {
        try await request(.put, "employees/\(employeeId)/schedule", body: WeeklyScheduleBody(weekly: weekly))
    }

    func setScheduleDays(employeeId: Int, _ body: ScheduleDaysBody) async throws -> WorkSchedule {
        try await request(.put, "employees/\(employeeId)/schedule/days", body: body)
    }

    func deleteScheduleDays(employeeId: Int, from: String, to: String) async throws -> WorkSchedule {
        try await request(
            .delete, "employees/\(employeeId)/schedule/days",
            query: queryItems(["from": from, "to": to])
        )
    }
}
