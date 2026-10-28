import Foundation

// MARK: - Deliveries (поставки)

extension APIClient {
    func createDelivery(_ body: DeliveryBody, idempotencyKey: UUID) async throws -> StockDelivery {
        try await request(.post, "stock/deliveries", body: body, idempotencyKey: idempotencyKey)
    }

    func deliveries(supplier: String? = nil, limit: Int = 50, offset: Int = 0) async throws -> ItemsResponse<StockDelivery> {
        try await request(.get, "stock/deliveries", query: queryItems([
            "supplier": supplier.nonEmpty,
            "limit": String(limit),
            "offset": String(offset),
        ]))
    }

    func delivery(id: Int) async throws -> StockDelivery {
        try await request(.get, "stock/deliveries/\(id)")
    }

    func suppliers() async throws -> [StockSupplier] {
        let response: ItemsResponse<StockSupplier> = try await request(.get, "stock/suppliers")
        return response.items
    }
}
