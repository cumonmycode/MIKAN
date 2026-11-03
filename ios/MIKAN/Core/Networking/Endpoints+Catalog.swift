import Foundation

// MARK: - Services, aftercare templates, products, stock, uploads

extension APIClient {
    /// Kept on the phone for offline use.
    func services(includeInactive: Bool = false) async throws -> [Service] {
        try await cachedGet(.services(includeInactive: includeInactive)) {
            let response: ItemsResponse<Service> = try await request(
                .get, "services",
                query: queryItems(["includeInactive": includeInactive ? "true" : nil])
            )
            return response.items
        }
    }

    func createService(_ body: ServiceBody) async throws -> Service {
        try await request(.post, "services", body: body)
    }

    func updateService(id: Int, _ body: ServiceBody) async throws -> Service {
        try await request(.patch, "services/\(id)", body: body)
    }

    /// Who got this service and when, newest first.
    func serviceHistory(id: Int, limit: Int = 50, offset: Int = 0) async throws -> ItemsResponse<HistoryEntry> {
        try await request(.get, "services/\(id)/history", query: queryItems([
            "limit": String(limit),
            "offset": String(offset),
        ]))
    }

    /// Generates the schematic cover with AI (takes 1–2 minutes).
    func generateServiceImage(id: Int, prompt: String?) async throws -> Service {
        try await request(
            .post, "services/\(id)/image/generate",
            body: GenerateImageBody(prompt: prompt.nonEmpty),
            timeout: Self.imageGenerationTimeout
        )
    }

    func aftercareTemplates() async throws -> [AftercareTemplate] {
        let response: ItemsResponse<AftercareTemplate> = try await request(.get, "aftercare-templates")
        return response.items
    }

    func createAftercareTemplate(_ body: AftercareTemplateBody) async throws -> AftercareTemplate {
        try await request(.post, "aftercare-templates", body: body)
    }

    func updateAftercareTemplate(id: Int, _ body: AftercareTemplateBody) async throws -> AftercareTemplate {
        try await request(.patch, "aftercare-templates/\(id)", body: body)
    }

    func deleteAftercareTemplate(id: Int) async throws {
        try await requestVoid(.delete, "aftercare-templates/\(id)")
    }

    func products(
        kind: ProductKind? = nil,
        search: String = "",
        lowStock: Bool = false,
        includeInactive: Bool = false
    ) async throws -> [Product] {
        let fetch = {
            let response: ItemsResponse<Product> = try await self.request(.get, "products", query: queryItems([
                "kind": kind?.rawValue,
                "search": search.nonEmpty,
                "lowStock": lowStock ? "true" : nil,
                "includeInactive": includeInactive ? "true" : nil,
            ]))
            return response.items
        }
        // A whole kind (with its sizes) is kept on the phone for offline use; searches and filters are not.
        guard let kind, search.isEmpty, !lowStock else { return try await fetch() }
        return try await cachedGet(.products(kind: kind, includeInactive: includeInactive), fetch)
    }

    func product(id: Int) async throws -> Product {
        try await request(.get, "products/\(id)")
    }

    func createProduct(_ body: ProductBody) async throws -> Product {
        try await request(.post, "products", body: body)
    }

    func updateProduct(id: Int, _ body: ProductBody) async throws -> Product {
        try await request(.patch, "products/\(id)", body: body)
    }

    /// Moves the product into a category of its section (the server registers a new name), or out of any (`nil`);
    /// nothing else on the card changes.
    func setProductCategory(id: Int, category: String?) async throws -> Product {
        try await request(.patch, "products/\(id)", body: ProductCategoryBody(category: Nullable(category?.nonEmpty)))
    }

    /// Deletes a product without history and archives one with it; `writeOff` first writes the stock left off
    /// (without it the server refuses while stock is left). A product that is already gone (`404`) counts as deleted.
    func deleteProduct(id: Int, writeOff: Bool) async throws -> ProductDeletionResult {
        do {
            return try await request(.delete, "products/\(id)", query: queryItems(["writeOff": writeOff ? "true" : nil]))
        } catch let error as APIError where error.status == 404 {
            return ProductDeletionResult(deleted: true)
        }
    }

    func addMovement(productId: Int, _ body: MovementBody, idempotencyKey: UUID) async throws -> MovementResult {
        try await request(.post, "products/\(productId)/movements", body: body, idempotencyKey: idempotencyKey)
    }

    /// One operation over several sizes in one transaction.
    func addMovements(productId: Int, _ body: StockBatchBody, idempotencyKey: UUID) async throws -> BatchMovementResult {
        try await request(.post, "products/\(productId)/movements/batch", body: body, idempotencyKey: idempotencyKey)
    }

    /// A restock of a presence consumable with what it cost: a `purchase` movement and the new status.
    func recordPurchase(
        productId: Int,
        amount: Int,
        note: String?,
        presenceStatus: PresenceStatus?,
        idempotencyKey: UUID
    ) async throws -> MovementResult {
        let body = PurchaseBody(amount: amount, note: note.nonEmpty, presenceStatus: presenceStatus)
        return try await request(.post, "products/\(productId)/purchases", body: body, idempotencyKey: idempotencyKey)
    }

    /// Movements of the product, or of one size.
    func productMovements(
        productId: Int,
        variantId: Int? = nil,
        limit: Int = 50,
        offset: Int = 0
    ) async throws -> ItemsResponse<StockMovement> {
        try await request(.get, "products/\(productId)/movements", query: queryItems([
            "variantId": variantId.map(String.init),
            "limit": String(limit),
            "offset": String(offset),
        ]))
    }

    /// Who bought this product (or one size of it) and when, newest first.
    func productHistory(
        id: Int,
        variantId: Int? = nil,
        limit: Int = 50,
        offset: Int = 0
    ) async throws -> ItemsResponse<HistoryEntry> {
        try await request(.get, "products/\(id)/history", query: queryItems([
            "variantId": variantId.map(String.init),
            "limit": String(limit),
            "offset": String(offset),
        ]))
    }

    func stockMovements(type: MovementType? = nil, limit: Int = 50, offset: Int = 0) async throws -> ItemsResponse<StockMovement> {
        try await request(.get, "stock/movements", query: queryItems([
            "type": type?.rawValue,
            "limit": String(limit),
            "offset": String(offset),
        ]))
    }
}

// MARK: - Warehouse categories and stock counts

extension APIClient {
    func catalogCategories(section: CatalogSection? = nil) async throws -> [CatalogCategory] {
        let fetch = {
            let response: ItemsResponse<CatalogCategory> = try await self.request(
                .get, "catalog/categories", query: queryItems(["section": section?.rawValue])
            )
            return response.items
        }
        // Every section's categories are kept on the phone for offline use.
        guard section == nil else { return try await fetch() }
        return try await cachedGet(.categories, fetch)
    }

    func createCategory(_ body: CategoryCreateBody) async throws -> CatalogCategory {
        try await request(.post, "catalog/categories", body: body)
    }

    /// Renames the category and every item in it.
    func renameCategory(id: Int, name: String) async throws -> CatalogCategory {
        try await request(.patch, "catalog/categories/\(id)", body: ["name": name])
    }

    /// Every category of one section (and service category), in the new order.
    func orderCategories(ids: [Int]) async throws -> [CatalogCategory] {
        let response: ItemsResponse<CatalogCategory> = try await request(.put, "catalog/categories/order", body: ["ids": ids])
        return response.items
    }

    /// Moves the items into `intoId` and deletes the category.
    func mergeCategory(id: Int, into intoId: Int) async throws -> CatalogCategory {
        try await request(.post, "catalog/categories/\(id)/merge", body: ["intoId": intoId])
    }

    /// The items stay, without a category.
    func deleteCategory(id: Int) async throws {
        try await requestVoid(.delete, "catalog/categories/\(id)")
    }

    func createRevision(_ body: StockRevisionBody, idempotencyKey: UUID) async throws -> StockRevision {
        try await request(.post, "stock/revisions", body: body, idempotencyKey: idempotencyKey)
    }

    func revisions(limit: Int = 50, offset: Int = 0) async throws -> ItemsResponse<StockRevision> {
        try await request(.get, "stock/revisions", query: queryItems([
            "limit": String(limit),
            "offset": String(offset),
        ]))
    }

    func revision(id: Int) async throws -> StockRevision {
        try await request(.get, "stock/revisions/\(id)")
    }
}
