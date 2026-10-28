import Foundation

/// The lines of the cart: adding products in a size, services and certificates, the units in it and the stock of
/// each size.
extension CartStore {
    /// Units of the product in all its sizes (the catalog tile badge).
    func quantity(ofProduct productId: Int) -> Int {
        lines.filter { $0.productId == productId }.reduce(0) { $0 + $1.quantity }
    }

    /// Units of one size, summed over its lines (an edited price makes a separate line of the same size).
    func quantity(ofVariant variantId: Int) -> Int {
        lines.filter { $0.variantId == variantId }.reduce(0) { $0 + $1.quantity }
    }

    func quantity(ofService serviceId: Int) -> Int {
        lines.filter { $0.kind == .service(id: serviceId) }.reduce(0) { $0 + $1.quantity }
    }

    /// Units of one variant of a service (its lines are named «Соски — Два»).
    func quantity(ofService serviceId: Int, named name: String) -> Int {
        lines.filter { $0.kind == .service(id: serviceId) && $0.name == name }.reduce(0) { $0 + $1.quantity }
    }

    /// Adds one of a size at its catalog price. A product with one size may come without `variant` (its only size
    /// is sold); a product with several sizes needs one, otherwise nothing is added and the result is `false`.
    /// The same size at the same price bumps the quantity; another size, or a line repriced in the receipt,
    /// is a separate line.
    @discardableResult
    func add(product: Product, variant: ProductVariant? = nil) -> Bool {
        guard let size = Self.size(of: product, variant) else { return false }
        let line = CartLine(
            kind: .product(id: product.id, variantId: size.id, stock: size.quantity),
            name: product.lineName(variant: size),
            sizeName: size.name,
            unitPrice: product.price(of: size),
            productKind: product.kind
        )
        if let index = lines.firstIndex(where: { $0.isSameSize(as: line) && $0.unitPrice == line.unitPrice }) {
            lines[index].quantity += 1
        } else {
            lines.append(line)
        }
        return true
    }

    /// The size to sell: the product's own copy of `variant` (fresh stock), or its only size.
    private static func size(of product: Product, _ variant: ProductVariant?) -> ProductVariant? {
        guard let variant else { return product.hasSeveralSizes ? nil : product.variants.first }
        return product.variant(id: variant.id)
    }

    // MARK: Stock

    /// Units of the line's size in the whole receipt.
    func sizeQuantity(of line: CartLine) -> Int {
        lines.filter { $0.isSameSize(as: line) }.reduce(0) { $0 + $1.quantity }
    }

    /// How many the line may hold so that all lines of its size stay within the stock; `nil` for services.
    func stockLimit(for line: CartLine) -> Int? {
        guard let stock = line.stock else { return nil }
        return stock - (sizeQuantity(of: line) - line.quantity)
    }

    /// All lines of the line's size together ask for more than its stock (the server answers `insufficient_stock`).
    func exceedsStock(_ line: CartLine) -> Bool {
        guard let stock = line.stock else { return false }
        return sizeQuantity(of: line) > stock
    }

    /// «На складе только 1 шт размера 8 мм» under every line of a size that is short; `nil` otherwise.
    func stockWarning(for line: CartLine) -> String? {
        guard let stock = line.stock else { return nil }
        return ReceiptStock.warning(
            stock: stock, inReceipt: sizeQuantity(of: line), lineQuantity: line.quantity, sizeName: line.sizeName
        )
    }

    /// Adds a catalog service (or one of its variants) at the price of `masterId` (their own price, else the
    /// catalog one; see `ReceiptPricing.masterId`). Repeating the same service at the same price bumps the quantity;
    /// a line whose price was edited in the receipt stays separate.
    func add(service: Service, variant: ServiceVariant? = nil, masterId: Int? = nil) {
        let line = CartLine(
            kind: .service(id: service.id),
            name: service.lineName(variant: variant),
            unitPrice: service.price(for: masterId, variant: variant)
        )
        if let index = lines.firstIndex(where: { $0.kind == line.kind && $0.name == line.name && $0.unitPrice == line.unitPrice }) {
            lines[index].quantity += 1
        } else {
            lines.append(line)
        }
    }

    /// «Подарочный сертификат» for `amount` rubles; the sale issues it. Such a receipt is paid with money only.
    func addCertificate(amount: Int, recipientName: String) {
        lines.append(.certificate(amount: amount, recipientName: recipientName))
    }

    func addCustomService(name: String, price: Int) {
        lines.append(CartLine(kind: .service(id: nil), name: name.trimmed, unitPrice: max(0, price)))
    }

    func remove(at offsets: IndexSet) {
        lines.remove(atOffsets: offsets)
    }

    func removeLine(id: CartLine.ID) {
        lines.removeAll { $0.id == id }
    }
}
