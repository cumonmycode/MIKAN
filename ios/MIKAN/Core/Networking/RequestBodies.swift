import Foundation

/// Optional value that encodes `nil` as an explicit JSON `null` (instead of omitting the key),
/// so PATCH requests can clear fields.
nonisolated struct Nullable<Value: Encodable & Sendable>: Encodable, Sendable, ExpressibleByNilLiteral {
    let value: Value?

    init(_ value: Value?) {
        self.value = value
    }

    init(nilLiteral: ()) {
        self.value = nil
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        if let value {
            try container.encode(value)
        } else {
            try container.encodeNil()
        }
    }
}

nonisolated extension Nullable: Equatable where Value: Equatable {}
nonisolated extension Nullable: Hashable where Value: Hashable {}

nonisolated struct LoginBody: Encodable, Sendable {
    let login: String
    let password: String
}

/// `POST /employees`, `PATCH /employees/:id`. Fields the signed-in employee may not change are omitted
/// (see `EmployeeBody.make`).
nonisolated struct EmployeeBody: Encodable, Sendable {
    var name: String
    var login: String?
    /// Omitted when not changing the password.
    var password: String?
    var phone: Nullable<String>
    var color: Nullable<String>
    var isMaster: Bool?
    var role: EmployeeRole?
    var active: Bool?
}

nonisolated struct ClientBody: Encodable, Sendable {
    var name: String
    var lastName: Nullable<String>
    var phone: Nullable<String>
    var instagram: Nullable<String>
    var telegramNick: Nullable<String>
    var birthday: Nullable<String>
    var notes: Nullable<String>
    var source: Nullable<String>
    var botEnabled: Bool
}

nonisolated struct ArchiveBody: Encodable, Sendable {
    let archived: Bool
}

nonisolated struct ServiceBody: Encodable, Sendable {
    var name: String
    var category: ServiceCategory
    var group: Nullable<String> = nil
    var price: Int
    var priceMax: Nullable<Int> = nil
    var priceFrom: Bool
    var durationMin: Int
    var description: Nullable<String>
    var imageUrl: Nullable<String> = nil
    var imagePrompt: Nullable<String> = nil
    var photos: [String] = []
    var variants: [ServiceVariant] = []
    /// Prepayment required to book the service; 0 — none.
    var depositAmount = 0
    /// Replaces the masters' own prices; `nil` — unchanged.
    var masterPrices: [ServiceMasterPrice]? = nil
    var aftercareTemplateId: Nullable<Int>
    /// «Свежий прокол» / «Свежее тату»: aftercare memos are sent only for such services.
    var freshProcedure: Bool
    /// Post-visit follow-ups of the bot: days until «Как заживает?», weeks until the jewelry change; `null` — never.
    var healingCheckDays: Nullable<Int>
    var jewelryChangeWeeks: Nullable<Int>
    /// Replace the compatible jewelry and the consumption norm.
    var jewelryIds: [Int] = []
    var consumables: [ServiceConsumable] = []
    var active: Bool
    var sort: Int
}

nonisolated struct GenerateImageBody: Encodable, Sendable {
    /// Omitted to reuse the saved `imagePrompt`.
    var prompt: String?
}

nonisolated struct AftercareTemplateBody: Encodable, Sendable {
    var name: String
    var category: ServiceCategory
    var steps: [AftercareStep]
}

/// `POST /products` and `PATCH /products/:id`. `variants` replaces the sizes: an item with `id` updates that size,
/// one without adds a size, and a size left out is removed (see docs/API.md).
nonisolated struct ProductBody: Encodable, Hashable, Sendable {
    var kind: ProductKind
    var name: String
    var sku: Nullable<String>
    var category: Nullable<String>
    var material: Nullable<String>
    var threadType: Nullable<ThreadType>
    var thicknessMm: Nullable<Double>
    var color: Nullable<String>
    var stone: Nullable<String>
    var supplier: Nullable<String>
    var description: Nullable<String>
    var price: Int
    var cost: Nullable<Int>
    var unit: String
    var photos: [String]
    var serviceIds: [Int]
    /// Consumables only; omitted keeps it.
    var stockMode: StockMode? = nil
    /// Presence consumables only; omitted otherwise.
    var presenceStatus: PresenceStatus? = nil
    var active: Bool
    var variants: [ProductVariantBody]
}

nonisolated struct ProductVariantBody: Encodable, Hashable, Sendable {
    /// `nil` adds a new size.
    var id: Int?
    var name: String
    /// Own article / price / cost; `nil` = the product's.
    var sku: Nullable<String>
    var price: Nullable<Int>
    var cost: Nullable<Int>
    var minQuantity: Int
    /// New sizes only: recorded as a receipt «Начальный остаток».
    var initialQuantity: Int?
}

nonisolated struct MovementBody: Encodable, Sendable {
    let type: MovementType
    let quantity: Int
    var note: Nullable<String>
    /// Required by the server for a product with several sizes.
    var variantId: Int? = nil
}

/// `POST /products/:id/movements/batch` — one operation over several sizes (a delivery, a stock count).
nonisolated struct StockBatchBody: Encodable, Hashable, Sendable {
    let type: MovementType
    var note: String?
    /// Receipts only: what one unit cost on this delivery; becomes the new cost of what was received.
    var unitCost: Int? = nil
    let lines: [StockLineBody]
}

/// `quantity`: added / removed amount, or the counted stock for `adjustment`.
nonisolated struct StockLineBody: Encodable, Hashable, Sendable {
    let variantId: Int
    let quantity: Int
}

/// `POST /products/:id/purchases` — a restock of a presence consumable with what it cost.
nonisolated struct PurchaseBody: Encodable, Hashable, Sendable {
    /// Rubles paid, 1…100 000 000.
    let amount: Int
    var note: String?
    /// The status after the purchase; the server defaults to `ok`.
    var presenceStatus: PresenceStatus?
}

/// A booked service line; variants are resolved by the app (name/price/duration of the variant).
nonisolated struct AppointmentServiceBody: Encodable, Hashable, Sendable {
    var serviceId: Int?
    var name: String
    var price: Int
    var durationMin: Int?

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(serviceId, forKey: .serviceId)
        try c.encode(name, forKey: .name)
        try c.encode(price, forKey: .price)
        try c.encode(durationMin, forKey: .durationMin)
    }

    private enum CodingKeys: String, CodingKey { case serviceId, name, price, durationMin }
}

nonisolated struct AppointmentBody: Encodable, Sendable {
    var clientId: Int
    var masterId: Int
    /// Replaces all service lines when set (`[]` clears them); takes precedence over the legacy `serviceId`.
    var services: [AppointmentServiceBody]?
    var serviceId: Nullable<Int>
    var title: Nullable<String>
    var startsAt: Date
    var endsAt: Date
    var price: Int
    /// Prepayment the studio asks for. Received prepayments change only through the prepayment endpoints.
    var depositRequired: Int
    var notes: Nullable<String>
    /// Omitted unless the user confirmed saving despite a schedule conflict.
    var force: Bool?
}

/// `POST /appointments/:id/deposit` — the client paid the prepayment at the studio.
nonisolated struct DepositReceiveBody: Encodable, Hashable, Sendable {
    let amount: Int
    /// `cash`, `card` or `transfer` (QR goes through `DepositQrBody`).
    let method: PaymentMethod
    var note: String?
}

/// `POST /appointments/:id/deposit/refund` — omitted fields: the whole held amount, the method it was received by.
nonisolated struct DepositRefundBody: Encodable, Hashable, Sendable {
    var amount: Int?
    var method: PaymentMethod?
    var reason: String?
}

/// `POST /appointments/:id/deposit/retain` — only for cancelled / no-show appointments.
nonisolated struct DepositRetainBody: Encodable, Hashable, Sendable {
    var amount: Int?
    var reason: String?
}

/// `POST /appointments/:id/deposit/qr` — `amount` defaults to what is still missing.
nonisolated struct DepositQrBody: Encodable, Sendable {
    let delivery: DepositDelivery
    var amount: Int?
    /// Telegram chat to send the link to when the client has none linked (e.g. the booking request's chat).
    var chatId: Int64?
}

/// `POST /appointments/:id/deposit/remind`.
nonisolated struct DepositRemindBody: Encodable, Sendable {
    var chatId: Int64?
}

nonisolated struct StatusBody<Status: Encodable & Sendable>: Encodable, Sendable {
    let status: Status
}

nonisolated struct ConsumableUse: Encodable, Hashable, Sendable {
    let productId: Int
    let quantity: Int
    /// Needed only for a product with several sizes (consumables have one).
    var variantId: Int? = nil
}

nonisolated struct CompleteBody: Encodable, Sendable {
    let sendAftercare: Bool
    let aftercareTemplateId: Int?
    /// `nil` (omitted) — the server deducts the norms of the appointment's services; a list — exactly these.
    var consumables: [ConsumableUse]?
}

/// `POST /catalog/categories`.
nonisolated struct CategoryCreateBody: Encodable, Sendable {
    let section: CatalogSection
    var serviceCategory: ServiceCategory?
    let name: String
}

/// `PATCH /products/:id` with the category only; `null` takes the product out of its category.
nonisolated struct ProductCategoryBody: Encodable, Sendable {
    let category: Nullable<String>
}

/// `POST /stock/revisions` — the counted stock per size and the marked status per presence consumable.
nonisolated struct StockRevisionBody: Encodable, Hashable, Sendable {
    var section: CatalogSection?
    var note: String?
    var counts: [StockLineBody]
    var presence: [PresenceLineBody]
}

nonisolated struct PresenceLineBody: Encodable, Hashable, Sendable {
    let productId: Int
    let status: PresenceStatus
}

nonisolated struct SaleItemBody: Encodable, Hashable, Sendable {
    let type: SaleItemType
    let productId: Int?
    let serviceId: Int?
    let name: String?
    let quantity: Int
    let price: Int
    /// The size sold; required by the server for a product with several sizes.
    var variantId: Int? = nil
    /// Who a gift certificate (`type: certificate`) is for, and a note kept on it; omitted for other lines.
    var recipientName: String? = nil
    var note: String? = nil
}

/// `POST /sales` and `POST /qr-payments`.
nonisolated struct SaleBody: Encodable, Sendable {
    let clientId: Int?
    let appointmentId: Int?
    let items: [SaleItemBody]
    let discount: Int
    let payments: Payments
    let note: String?
    /// The open receipt being paid: the server deletes it together with the sale.
    var receiptId: Int? = nil
}

/// `POST /receipts` and `PUT /receipts/:id`. `PUT` replaces the whole receipt: omitted ids and note mean none.
nonisolated struct ReceiptBody: Encodable, Hashable, Sendable {
    var appointmentId: Int?
    var clientId: Int?
    /// Omitted (`nil`) only when starting a visit: the server then takes the appointment's service lines.
    var items: [SaleItemBody]?
    var discount = 0
    var note: String?

    /// «Начать визит»: the appointment's receipt with its client and services (the existing one if already open).
    static func visit(appointmentId: Int) -> ReceiptBody {
        ReceiptBody(appointmentId: appointmentId, clientId: nil, items: nil, note: nil)
    }

    /// An empty receipt, optionally for a client.
    static func blank(clientId: Int? = nil) -> ReceiptBody {
        ReceiptBody(appointmentId: nil, clientId: clientId, items: [], note: nil)
    }
}

nonisolated struct RefundBody: Encodable, Sendable {
    let reason: String
    let restock: Bool
    /// The lines and units to return; `nil` — everything not returned yet.
    var items: [RefundItemBody]? = nil
}

nonisolated struct RefundItemBody: Codable, Hashable, Sendable {
    let saleItemId: Int
    let quantity: Int
}

/// `POST /sales/:id/refund/preview`.
nonisolated struct RefundPreviewBody: Encodable, Sendable {
    var items: [RefundItemBody]?
}

/// `POST /sales/:id/send` — to a chosen bot chat, else the client's chat.
nonisolated struct SendReceiptBody: Encodable, Sendable {
    var chatId: Int64?
}

/// `POST /stock/deliveries`.
nonisolated struct DeliveryBody: Encodable, Sendable {
    var supplier: String?
    var note: String?
    var lines: [DeliveryLineBody]
}

nonisolated struct DeliveryLineBody: Encodable, Hashable, Sendable {
    let productId: Int
    let variantId: Int
    let quantity: Int
    /// What one unit cost on this delivery; `nil` — unknown (the cost does not change).
    var unitCost: Int?
}

nonisolated struct OpenShiftBody: Encodable, Sendable {
    let openingCash: Int
}

nonisolated struct CloseShiftBody: Encodable, Sendable {
    let closingCash: Int
    let note: String?
}

nonisolated struct CashOperationBody: Encodable, Sendable {
    let type: CashOperationType
    let amount: Int
    let reason: String
}

nonisolated struct TextBody: Encodable, Sendable {
    let text: String
}

nonisolated struct AIPausedBody: Encodable, Sendable {
    let aiPaused: Bool
}

/// `PUT /bot/chats/:chatId/employee`.
nonisolated struct ChatEmployeeBody: Encodable, Sendable {
    let employeeId: Int
}

nonisolated struct KnowledgeBody: Encodable, Sendable {
    var title: String
    var content: String
    var active: Bool
    var sort: Int?
}
