import Foundation

// MARK: - Masters' portfolio

extension APIClient {
    /// The master's photos in their order; `serviceId` keeps only the photos of that service.
    func portfolio(employeeId: Int, serviceId: Int? = nil) async throws -> [PortfolioPhoto] {
        let response: ItemsResponse<PortfolioPhoto> = try await request(.get, "portfolio", query: queryItems([
            "employeeId": String(employeeId),
            "serviceId": serviceId.map(String.init),
        ]))
        return response.items
    }

    /// Adds an uploaded photo after the master's other photos.
    func addPortfolioPhoto(_ body: PortfolioPhotoBody) async throws -> PortfolioPhoto {
        try await request(.post, "portfolio", body: body)
    }

    func updatePortfolioPhoto(id: Int, _ body: PortfolioPhotoPatch) async throws -> PortfolioPhoto {
        try await request(.patch, "portfolio/\(id)", body: body)
    }

    /// `ids` lists every photo of the master in the new order; answers with the photos in that order.
    func reorderPortfolio(employeeId: Int, ids: [Int]) async throws -> [PortfolioPhoto] {
        let response: ItemsResponse<PortfolioPhoto> = try await request(
            .put, "portfolio/order", body: PortfolioOrderBody(employeeId: employeeId, ids: ids)
        )
        return response.items
    }

    /// A photo that is already gone (`404`) counts as deleted.
    func deletePortfolioPhoto(id: Int) async throws {
        do {
            try await requestVoid(.delete, "portfolio/\(id)")
        } catch let error as APIError where error.status == 404 {
            return
        }
    }
}
