import Foundation

/// A receipt being put together before payment (`/receipts`). Nothing is sold yet: no stock moves, a prepayment
/// stays held. Several can be open at once and every device sees the same list.
nonisolated struct OpenReceipt: Decodable, Hashable, Identifiable, Sendable {
    let id: Int
    /// The whole appointment it pays for (status, held prepayment); `nil` without one.
    var appointment: Appointment?
    var client: ClientRef?
    /// Lines in order, as saved.
    var items: [OpenReceiptItem] = []
    var subtotal: Int
    var discount: Int
    var total: Int
    /// Σ quantity.
    var itemCount: Int
    var note: String?
    /// The employee who opened it.
    var openedBy: EmployeeRef?
    let createdAt: Date
    var updatedAt: Date
}

nonisolated extension OpenReceipt {
    private enum CodingKeys: String, CodingKey {
        case id, appointment, client, items, subtotal, discount, total, itemCount, note, openedBy, createdAt, updatedAt
    }

    /// Derives the totals from the lines when a field is missing.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        appointment = try c.decodeIfPresent(Appointment.self, forKey: .appointment)
        client = try c.decodeIfPresent(ClientRef.self, forKey: .client)
        items = try c.decodeIfPresent([OpenReceiptItem].self, forKey: .items) ?? []
        let lineSum = items.reduce(0) { $0 + $1.total }
        subtotal = try c.decodeIfPresent(Int.self, forKey: .subtotal) ?? lineSum
        discount = try c.decodeIfPresent(Int.self, forKey: .discount) ?? 0
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? subtotal - discount
        itemCount = try c.decodeIfPresent(Int.self, forKey: .itemCount) ?? items.reduce(0) { $0 + $1.quantity }
        note = try c.decodeIfPresent(String.self, forKey: .note)
        openedBy = try c.decodeIfPresent(EmployeeRef.self, forKey: .openedBy)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? createdAt
    }
}

/// One line of an open receipt: a product in one size, or a service.
nonisolated struct OpenReceiptItem: Decodable, Hashable, Sendable {
    let type: SaleItemType
    var productId: Int?
    var variantId: Int?
    /// The size's name (`nil` for services and a product without sizes).
    var variantName: String?
    /// Jewelry or goods for product lines.
    var productKind: ProductKind?
    var serviceId: Int?
    /// «Лабрет — 8 мм» for a product in a size; the saved name for a service.
    let name: String
    let quantity: Int
    /// Unit price saved for the line.
    let price: Int
    var total: Int
    /// The size's current quantity; `nil` for services and a size that is gone.
    var stock: Int?
    /// Set on a gift certificate to sell (a `service` line named «Подарочный сертификат»); `nil` on other lines.
    var certificate: OpenReceiptCertificate? = nil
}

/// `OpenReceiptItem.certificate`: who the certificate to sell is for. It has no code until the sale issues it.
nonisolated struct OpenReceiptCertificate: Decodable, Hashable, Sendable {
    var recipientName: String?
    var note: String?
}

nonisolated extension OpenReceiptItem {
    private enum CodingKeys: String, CodingKey {
        case type, productId, variantId, variantName, productKind, serviceId, name, quantity, price, total, stock
        case certificate
    }

    /// An unknown `productKind` reads as none (the line then shows the jewelry icon); an unreadable `certificate`
    /// as none.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(SaleItemType.self, forKey: .type)
        productId = try c.decodeIfPresent(Int.self, forKey: .productId)
        variantId = try c.decodeIfPresent(Int.self, forKey: .variantId)
        variantName = try c.decodeIfPresent(String.self, forKey: .variantName)
        productKind = try? c.decodeIfPresent(ProductKind.self, forKey: .productKind)
        serviceId = try c.decodeIfPresent(Int.self, forKey: .serviceId)
        name = try c.decode(String.self, forKey: .name)
        quantity = try c.decode(Int.self, forKey: .quantity)
        price = try c.decode(Int.self, forKey: .price)
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? quantity * price
        stock = try c.decodeIfPresent(Int.self, forKey: .stock)
        certificate = try? c.decodeIfPresent(OpenReceiptCertificate.self, forKey: .certificate)
    }
}
