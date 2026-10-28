import SwiftUI

/// One size chip of a catalog card: name, price, stock and how many are already in the receipt.
nonisolated struct SizeOption: Identifiable, Equatable, Sendable {
    enum Stock: Equatable, Sendable {
        case inStock
        case low
        case out
    }

    let id: Int
    let title: String
    let price: Int
    let stock: Stock
    /// «4 шт», «Мало: 1 шт», «Нет в наличии».
    let stockText: String
    let inReceipt: Int
    /// Everything in stock is already in the receipt: one more would exceed the stock.
    let isStockInReceipt: Bool

    init(product: Product, variant: ProductVariant, inReceipt: Int) {
        id = variant.id
        title = variant.name.nonEmpty ?? "Без размера"
        price = product.price(of: variant)
        let count = "\(variant.quantity) \(product.unitLabel)"
        if !variant.isAvailable {
            stock = .out
            stockText = "Нет в наличии"
        } else if variant.lowStock {
            stock = .low
            stockText = "Мало: \(count)"
        } else {
            stock = .inStock
            stockText = count
        }
        self.inReceipt = inReceipt
        isStockInReceipt = variant.isAvailable && inReceipt >= variant.quantity
    }

    /// Out-of-stock sizes cannot be picked.
    var isAvailable: Bool { stock != .out }

    /// One more can go into the receipt: in stock and not all of it there yet.
    var canAdd: Bool { isAvailable && !isStockInReceipt }

    /// «В чеке: 2»; `nil` while the size is not in the receipt.
    var inReceiptText: String? { inReceipt > 0 ? "В чеке: \(inReceipt)" : nil }

    /// «8 мм, 1 500 ₽, мало: 1 шт, в чеке: 2».
    var accessibilityLabel: String {
        let parts = [title, Money.format(price), stockText.lowercased(), inReceiptText?.lowercased()]
        return parts.compactMap { $0 }.joined(separator: ", ")
    }

    static func options(for product: Product, inReceipt: (Int) -> Int) -> [SizeOption] {
        product.variants.map { SizeOption(product: product, variant: $0, inReceipt: inReceipt($0.id)) }
    }

    /// Prices go on the chips only when the sizes cost differently.
    static func showsPrices(_ options: [SizeOption]) -> Bool {
        Set(options.map(\.price)).count > 1
    }
}

/// A jewelry piece or goods in the catalog. With one size the card adds it on tap; with several, each size is a chip
/// on the card that adds one unit of it. Counts in the receipt show as badges.
struct CatalogProductCard: View {
    @Environment(CartStore.self) private var cart
    let product: Product
    let onAdd: (ProductVariant) -> Void

    private var options: [SizeOption] {
        SizeOption.options(for: product) { cart.quantity(ofVariant: $0) }
    }

    var body: some View {
        if product.hasSeveralSizes {
            let options = options
            let showsPrices = SizeOption.showsPrices(options)
            VStack(alignment: .leading, spacing: 12) {
                header(count: cart.quantity(ofProduct: product.id), showsPlus: false)
                    .accessibilityElement(children: .combine)
                InventoryFlowLayout(spacing: 8, lineSpacing: 8) {
                    ForEach(options) { option in
                        CatalogChip(option: option, showsPrice: showsPrices) { add(option) }
                    }
                }
            }
            .catalogCard()
        } else {
            let single = options.first
            Button {
                if let single { add(single) }
            } label: {
                header(count: cart.quantity(ofProduct: product.id), showsPlus: single?.canAdd == true)
                    .catalogCard()
                    .contentShape(.rect(cornerRadius: 20))
            }
            .buttonStyle(.plain)
            .disabled(single?.canAdd != true)
            .accessibilityLabel("\(product.name), \(product.priceText), \(ProductTileText.accessibilityStock(product))")
            .accessibilityValue(single.map { $0.inReceipt > 0 ? "В чеке: \($0.inReceipt)" : "" } ?? "")
            .accessibilityHint(single?.canAdd == true ? "Добавить в чек" : (single?.isAvailable == true ? "Весь остаток уже в чеке" : "Нет в наличии"))
        }
    }

    private func header(count: Int, showsPlus: Bool) -> some View {
        HStack(spacing: 12) {
            ProductThumbnail(path: product.photoUrl, size: 64, placeholderSymbol: CatalogSection(kind: product.kind).symbol)
            VStack(alignment: .leading, spacing: 3) {
                Text(product.name)
                    .font(.headline)
                    .lineLimit(2)
                if !product.detailLine.isEmpty {
                    Text(product.detailLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                HStack(spacing: 8) {
                    Text(product.priceText)
                        .font(.subheadline.weight(.semibold))
                    Text(ProductTileText.stock(product))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(product.lowStock ? Color.red : Color.secondary)
                }
                .monospacedDigit()
                .lineLimit(1)
            }
            .opacity(product.isAvailable ? 1 : 0.5)
            Spacer(minLength: 8)
            CatalogCountBadge(count: count, showsPlus: showsPlus)
        }
        .foregroundStyle(.primary)
    }

    private func add(_ option: SizeOption) {
        guard option.canAdd, let variant = product.variant(id: option.id) else { return }
        onAdd(variant)
    }
}

/// A size or variant on a catalog card: «8 мм» with a line under it (its price, «Мало: 1 шт», «нет»); a badge with how
/// many are in the receipt. One tap adds one.
struct CatalogChip: View {
    let title: String
    var subtitle: String?
    /// The subtitle warns (low stock).
    var isWarning = false
    let count: Int
    var isEnabled = true
    let accessibilityLabel: String
    var disabledHint = "Нет в наличии"
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 1) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                if let subtitle {
                    Text(subtitle)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(isWarning ? Color.red : Color.secondary)
                }
            }
            .monospacedDigit()
            .lineLimit(1)
            .padding(.horizontal, 14)
            .frame(minWidth: 56, minHeight: 44)
            .background(count > 0 ? Color.accentColor.opacity(0.18) : Color(.tertiarySystemFill), in: .rect(cornerRadius: 14))
            .overlay(alignment: .topTrailing) {
                if count > 0 {
                    Text("\(count)")
                        .font(.caption2.weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(.white)
                        .frame(minWidth: 20, minHeight: 20)
                        .background(Color.accentColor, in: .circle)
                        .offset(x: 6, y: -6)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .contentShape(.rect(cornerRadius: 14))
            .opacity(isEnabled ? 1 : 0.45)
            .animation(.snappy, value: count)
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(isEnabled ? "Добавить один в чек" : disabledHint)
    }
}

private extension CatalogChip {
    /// A size: its price when sizes cost differently, «Мало: 1 шт» when low, «нет» when out of stock.
    init(option: SizeOption, showsPrice: Bool, action: @escaping () -> Void) {
        let subtitle: String? = if !option.isAvailable {
            "нет"
        } else if showsPrice {
            Money.format(option.price)
        } else {
            option.stock == .low ? option.stockText : nil
        }
        self.init(
            title: option.title,
            subtitle: subtitle,
            isWarning: option.stock == .low && !showsPrice,
            count: option.inReceipt,
            isEnabled: option.canAdd,
            accessibilityLabel: option.accessibilityLabel,
            disabledHint: option.isAvailable ? "Весь остаток уже в чеке" : "Нет в наличии",
            action: action
        )
    }
}

/// How many of a catalog item the receipt has (a «+» while none, when it can be added on tap).
struct CatalogCountBadge: View {
    let count: Int
    let showsPlus: Bool

    var body: some View {
        Group {
            if count > 0 {
                Text("\(count)")
                    .font(.subheadline.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .frame(minWidth: 30, minHeight: 30)
                    .background(Color.accentColor, in: .circle)
                    .transition(.scale.combined(with: .opacity))
                    .accessibilityLabel("В чеке: \(count)")
            } else if showsPlus {
                Image(systemName: "plus.circle.fill")
                    .font(.title2)
                    .foregroundStyle(Color.accentColor)
                    .accessibilityHidden(true)
            }
        }
        .animation(.snappy, value: count)
    }
}

extension View {
    /// The card of a catalog item.
    func catalogCard() -> some View {
        padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 20))
    }
}
