import Foundation

// MARK: - Waitlist (docs/API.md «Waitlist»)

extension APIClient {
    /// Entries in those statuses (all when empty), oldest first; closed ones only of the last 90 days.
    func waitlist(statuses: [WaitlistStatus] = []) async throws -> [WaitlistEntry] {
        let status = statuses.isEmpty ? nil : statuses.map(\.rawValue).joined(separator: ",")
        let response: ItemsResponse<WaitlistEntry> = try await request(
            .get, "waitlist",
            query: queryItems(["status": status])
        )
        return response.items
    }

    /// Puts a client on the waitlist; the same open wish again returns the existing entry.
    func createWaitlistEntry(_ body: WaitlistBody) async throws -> WaitlistEntry {
        try await request(.post, "waitlist", body: body)
    }

    /// Cancels an open entry (`409` once it is booked or expired).
    func cancelWaitlistEntry(id: Int) async throws -> WaitlistEntry {
        try await request(.patch, "waitlist/\(id)", body: WaitlistStatusBody(status: .cancelled))
    }
}
