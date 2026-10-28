import Foundation

// MARK: - Auth, badges, dashboard, employees, settings

extension APIClient {
    /// Opens a session named after this iPhone (docs/API.md «Sessions»).
    func login(_ login: String, password: String) async throws -> LoginResponse {
        try await request(
            .post, "auth/login",
            body: LoginBody(login: login, password: password),
            headers: [DeviceName.headerField: DeviceName.current]
        )
    }

    func me() async throws -> Employee {
        try await request(.get, "auth/me")
    }

    func badges() async throws -> Badges {
        try await request(.get, "badges")
    }

    func dashboard() async throws -> Dashboard {
        try await request(.get, "dashboard")
    }

    /// Kept on the phone for offline use.
    func employees(includeInactive: Bool = false) async throws -> [Employee] {
        try await cachedGet(.employees(includeInactive: includeInactive)) {
            let response: ItemsResponse<Employee> = try await request(
                .get, "employees",
                query: queryItems(["includeInactive": includeInactive ? "true" : nil])
            )
            return response.items
        }
    }

    func createEmployee(_ body: EmployeeBody) async throws -> Employee {
        try await request(.post, "employees", body: body)
    }

    func updateEmployee(id: Int, _ body: EmployeeBody) async throws -> Employee {
        try await request(.patch, "employees/\(id)", body: body)
    }

    /// Kept on the phone for offline use.
    func studioSettings() async throws -> StudioSettings {
        try await cachedGet(.studioSettings) { try await request(.get, "settings/studio") }
    }

    func saveStudioSettings(_ settings: StudioSettings) async throws -> StudioSettings {
        try await request(.put, "settings/studio", body: settings)
    }

    /// Kept on the phone for offline use.
    func botSettings() async throws -> BotSettings {
        try await cachedGet(.botSettings) { try await request(.get, "settings/bot") }
    }

    func saveBotSettings(_ settings: BotSettings) async throws -> BotSettings {
        try await request(.put, "settings/bot", body: settings)
    }
}
