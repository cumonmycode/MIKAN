import Foundation

// MARK: - Sign-in sessions (docs/API.md «Sessions»)

extension APIClient {
    /// Ends this iPhone's session.
    func logout() async throws {
        try await requestVoid(.post, "auth/logout")
    }

    /// Your own active sessions; the owner gets everyone's (`employeeId` filters).
    func sessions(employeeId: Int? = nil) async throws -> [AuthSession] {
        let response: ItemsResponse<AuthSession> = try await request(
            .get, "auth/sessions",
            query: queryItems(["employeeId": employeeId.map(String.init)])
        )
        return response.items
    }

    /// Ends a session: your own, or anyone's for the owner. An ended one stays ended (`204`).
    func endSession(id: Int) async throws {
        try await requestVoid(.delete, "auth/sessions/\(id)")
    }
}
