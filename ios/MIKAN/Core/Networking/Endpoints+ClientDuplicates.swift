import Foundation

// MARK: - Duplicate client cards (docs/API.md «Clients» → «Duplicates», «Merge»)

extension APIClient {
    /// Likely duplicate cards, strongest reasons first, without the pairs marked as different people.
    func clientDuplicates() async throws -> [DuplicateGroup] {
        let response: ItemsResponse<DuplicateGroup> = try await request(.get, "clients/duplicates")
        return response.items
    }

    /// «Это разные люди»: these cards are not offered as duplicates again.
    func dismissDuplicates(clientIds: [Int]) async throws {
        try await requestVoid(.post, "clients/duplicates/dismiss", body: DuplicateDismissBody(clientIds: clientIds))
    }

    /// Merges card `id` into `intoId` (everything moves, card `id` is deleted); returns the kept card with its stats.
    func mergeClient(id: Int, into intoId: Int) async throws -> Client {
        try await request(.post, "clients/\(id)/merge", body: ClientMergeBody(intoId: intoId))
    }
}
