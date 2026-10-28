import XCTest
@testable import MIKAN

/// A labret in three sizes, as the till sees it: 6 мм (4 шт), 8 мм (1 шт, low), 10 мм (none, own price).
private enum SizeFixtures {
    static func variant(
        _ id: Int, _ name: String, quantity: Int, minQuantity: Int = 1, price: Int? = nil, sku: String? = nil
    ) -> ProductVariant {
        ProductVariant(
            id: id, name: name, sku: sku, price: price, cost: nil,
            quantity: quantity, minQuantity: minQuantity, lowStock: quantity <= minQuantity
        )
    }

    static let six = variant(11, "6 мм", quantity: 4)
    static let eight = variant(12, "8 мм", quantity: 1, minQuantity: 2, sku: "LB-12-08")
    static let ten = variant(13, "10 мм", quantity: 0, minQuantity: 0, price: 1_700, sku: "LB-12-10")

    static func labret(_ variants: [ProductVariant] = [six, eight, ten]) -> Product {
        Product(
            id: 1, kind: .jewelry, name: "Лабрет", sku: "LB-12", category: "Лабрет", material: "Титан ASTM F136",
            thicknessMm: 1.2, size: nil, description: nil, price: 1_500, cost: 600, quantity: 0, minQuantity: 0,
            unit: "шт", photoUrl: nil, active: true, lowStock: false, variants: variants,
            createdAt: Fixtures.referenceDate, updatedAt: Fixtures.referenceDate
        )
    }

    /// A product without sizes (one unnamed size) or with a single named one.
    static func ring(id: Int = 2, size: String? = nil, quantity: Int = 3) -> Product {
        Product(
            id: id, kind: .jewelry, name: "Кольцо-кликер", sku: "CL-10", category: "Кольцо", material: "Титан ASTM F136",
            size: size, description: nil, price: 2_800, cost: nil, quantity: quantity, minQuantity: 1, unit: "шт",
            photoUrl: nil, active: true, lowStock: quantity <= 1,
            createdAt: Fixtures.referenceDate, updatedAt: Fixtures.referenceDate
        )
    }
}

@MainActor
final class CartStoreSizeTests: XCTestCase {
    private lazy var suiteName: String = {
        let name = "CartStoreSizeTests.\(UUID().uuidString)"
        addTeardownBlock { UserDefaults.standard.removePersistentDomain(forName: name) }
        return name
    }()

    private func makeCart() throws -> CartStore {
        CartStore(defaults: try XCTUnwrap(UserDefaults(suiteName: suiteName)))
    }

    func testTheSameSizeTwiceBumpsTheQuantity() throws {
        let cart = try makeCart()
        let labret = SizeFixtures.labret()

        XCTAssertTrue(cart.add(product: labret, variant: SizeFixtures.six))
        XCTAssertTrue(cart.add(product: labret, variant: SizeFixtures.six))

        let line = try XCTUnwrap(cart.lines.first)
        XCTAssertEqual(cart.lines.count, 1)
        XCTAssertEqual(line.quantity, 2)
        XCTAssertEqual(line.kind, .product(id: 1, variantId: 11, stock: 4))
        XCTAssertEqual(line.name, "Лабрет — 6 мм")
        XCTAssertEqual(line.sizeName, "6 мм")
        XCTAssertEqual(line.unitPrice, 1_500)
    }

    func testTwoSizesMakeTwoLinesWithTheirOwnNamesAndPrices() throws {
        let cart = try makeCart()
        let ten = SizeFixtures.variant(13, "10 мм", quantity: 2, price: 1_700)
        let labret = SizeFixtures.labret([SizeFixtures.six, ten])

        cart.add(product: labret, variant: SizeFixtures.six)
        cart.add(product: labret, variant: ten)

        XCTAssertEqual(cart.lines.map(\.name), ["Лабрет — 6 мм", "Лабрет — 10 мм"])
        XCTAssertEqual(cart.lines.map(\.unitPrice), [1_500, 1_700], "a size with its own price sells at it")
        XCTAssertEqual(cart.lines.map(\.variantId), [11, 13])
        XCTAssertEqual(cart.lines.map(\.stock), [4, 2], "each line knows the stock of its size")
        XCTAssertEqual(cart.subtotal, 3_200)
    }

    func testSaleBodySendsTheSizeOfEveryProductLine() throws {
        let cart = try makeCart()
        let labret = SizeFixtures.labret()
        cart.add(product: labret, variant: SizeFixtures.eight)
        cart.add(product: labret, variant: SizeFixtures.six)
        cart.addCustomService(name: "Прокол", price: 2_000)

        let body = cart.makeSaleBody()
        XCTAssertEqual(body.items.map(\.productId), [1, 1, nil])
        XCTAssertEqual(body.items.map(\.variantId), [12, 11, nil])
        XCTAssertEqual(body.items.map(\.price), [1_500, 1_500, 2_000])

        let data = try JSONCoding.makeEncoder().encode(body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let items = try XCTUnwrap(json["items"] as? [[String: Any]])
        XCTAssertEqual(items[0]["variantId"] as? Int, 12)
        XCTAssertEqual(items[0]["type"] as? String, "product")
        XCTAssertNil(items[2]["variantId"], "services carry no size")
    }

    func testProductWithOneSizeIsAddedWithoutAVariant() throws {
        let cart = try makeCart()

        XCTAssertTrue(cart.add(product: SizeFixtures.ring(quantity: 3)))
        XCTAssertTrue(cart.add(product: SizeFixtures.ring(id: 3, size: "1.2×10 мм", quantity: 2)))

        XCTAssertEqual(cart.lines.map(\.kind), [
            .product(id: 2, variantId: 2, stock: 3),
            .product(id: 3, variantId: 3, stock: 2),
        ])
        XCTAssertEqual(cart.lines.map(\.name), ["Кольцо-кликер", "Кольцо-кликер — 1.2×10 мм"], "named like the server's sale items")
        XCTAssertEqual(cart.lines.map(\.sizeName), [nil, "1.2×10 мм"])
        XCTAssertEqual(cart.makeSaleBody().items.map(\.variantId), [2, 3], "the only size is always named")
    }

    func testProductWithSeveralSizesNeedsTheSize() throws {
        let cart = try makeCart()
        let labret = SizeFixtures.labret()

        XCTAssertFalse(cart.add(product: labret), "the server would answer 409 without a size")
        XCTAssertFalse(cart.add(product: labret, variant: SizeFixtures.variant(99, "12 мм", quantity: 5)), "not a size of this product")
        XCTAssertTrue(cart.isEmpty)
    }

    func testQuantitiesSumOverSizesAndOverLinesOfOneSize() throws {
        let cart = try makeCart()
        let labret = SizeFixtures.labret()
        cart.add(product: labret, variant: SizeFixtures.six)
        cart.add(product: labret, variant: SizeFixtures.six)
        cart.add(product: labret, variant: SizeFixtures.eight)
        cart.lines[1].unitPrice = 1_200
        cart.add(product: labret, variant: SizeFixtures.eight)
        cart.add(product: SizeFixtures.ring())

        XCTAssertEqual(cart.lines.count, 4, "a repriced line of a size is not merged")
        XCTAssertEqual(cart.quantity(ofProduct: 1), 4, "the tile badge counts every size")
        XCTAssertEqual(cart.quantity(ofProduct: 2), 1)
        XCTAssertEqual(cart.quantity(ofVariant: 11), 2)
        XCTAssertEqual(cart.quantity(ofVariant: 12), 2, "both lines of 8 мм")
        XCTAssertEqual(cart.quantity(ofVariant: 13), 0)
    }

    func testStockWarningCountsAllLinesOfOneSize() throws {
        let cart = try makeCart()
        let labret = SizeFixtures.labret()
        cart.add(product: labret, variant: SizeFixtures.eight)
        cart.add(product: labret, variant: SizeFixtures.six)
        XCTAssertNil(cart.stockWarning(for: cart.lines[0]), "1 of 1 is fine")
        XCTAssertEqual(cart.stockLimit(for: cart.lines[0]), 1)

        cart.lines[0].unitPrice = 1_200
        cart.add(product: labret, variant: SizeFixtures.eight)
        XCTAssertEqual(cart.lines.count, 3)

        let warning = "На складе только 1 шт размера 8 мм — в чеке 2"
        XCTAssertEqual(cart.stockWarning(for: cart.lines[0]), warning)
        XCTAssertEqual(cart.stockWarning(for: cart.lines[2]), warning)
        XCTAssertTrue(cart.exceedsStock(cart.lines[0]))
        XCTAssertTrue(cart.exceedsStock(cart.lines[2]))
        XCTAssertEqual(cart.stockLimit(for: cart.lines[2]), 0, "the other line already takes the only one")
        XCTAssertNil(cart.stockWarning(for: cart.lines[1]), "another size has its own stock")
        XCTAssertFalse(cart.exceedsStock(cart.lines[1]))

        cart.remove(at: [2])
        XCTAssertNil(cart.stockWarning(for: cart.lines[0]))
        cart.addCustomService(name: "Прокол", price: 2_000)
        XCTAssertNil(cart.stockWarning(for: cart.lines[2]), "services have no stock")
        XCTAssertNil(cart.stockLimit(for: cart.lines[2]))
    }

    func testAnotherSizeRenewsTheIdempotencyKey() throws {
        let cart = try makeCart()
        let labret = SizeFixtures.labret()
        cart.add(product: labret, variant: SizeFixtures.six)
        let key = cart.saleIdempotencyKey(for: cart.makeSaleBody())
        XCTAssertEqual(cart.saleIdempotencyKey(for: cart.makeSaleBody()), key, "a retry of the same cart")

        cart.lines.removeAll()
        cart.add(product: labret, variant: SizeFixtures.eight)
        XCTAssertNotEqual(cart.saleIdempotencyKey(for: cart.makeSaleBody()), key, "the same product in another size is another sale")
    }

    func testAReloadedVisitReceiptKeepsTheSizedLines() throws {
        let cart = try makeCart()
        let appointment = Appointment(
            id: 4, client: ClientRef(id: 1, name: "Иван Петров", phone: nil, telegramLinked: false),
            master: EmployeeRef(id: 2, name: "Анна", color: nil), service: ServiceRef(id: 3, name: "Хеликс", category: .piercing),
            title: nil, startsAt: Fixtures.referenceDate, endsAt: Fixtures.referenceDate.addingTimeInterval(1_800),
            status: .confirmed, price: 3_000, deposit: 1_000, notes: nil, saleId: nil, receiptId: 7, completedAt: nil,
            createdAt: Fixtures.referenceDate, updatedAt: Fixtures.referenceDate
        )
        let receipt = OpenReceipt(
            id: 7, appointment: appointment, client: appointment.client,
            items: [
                OpenReceiptItem(type: .service, serviceId: 3, name: "Хеликс", quantity: 1, price: 3_000, total: 3_000),
                OpenReceiptItem(
                    type: .product, productId: 1, variantId: 12, variantName: "8 мм", productKind: .jewelry,
                    name: "Лабрет — 8 мм", quantity: 1, price: 1_500, total: 1_500, stock: 1
                ),
            ],
            subtotal: 4_500, discount: 0, total: 4_500, itemCount: 2, note: nil, openedBy: nil,
            createdAt: Fixtures.referenceDate, updatedAt: Fixtures.referenceDate
        )

        cart.load(receipt)

        XCTAssertEqual(cart.lines.map(\.name), ["Хеликс", "Лабрет — 8 мм"])
        XCTAssertEqual(cart.lines.map(\.sizeName), [nil, "8 мм"])
        XCTAssertEqual(cart.makeSaleBody().items.map(\.variantId), [nil, 12])
        XCTAssertEqual(cart.makeSaleBody().payments.deposit, 1_000, "the prepayment still counts")
        XCTAssertEqual(cart.stockLimit(for: cart.lines[1]), 1, "the size's current stock")
    }
}

/// Texts and rules of jewelry sizes at the till: catalog tiles and search, the size picker, receipt lines,
/// refunds and the report.
final class POSSizeTextTests: XCTestCase {
    func testCatalogSearchMatchesSizeNamesAndSizeArticles() {
        let products = [SizeFixtures.labret(), SizeFixtures.ring(), SizeFixtures.ring(id: 3, size: "1.2×10 мм")]

        XCTAssertEqual(ProductCatalogFilter.apply(products, query: "8 мм", category: nil).map(\.id), [1])
        XCTAssertEqual(ProductCatalogFilter.apply(products, query: " LB-12-10 ", category: nil).map(\.id), [1], "the article of a size")
        XCTAssertEqual(ProductCatalogFilter.apply(products, query: "10 мм", category: nil).map(\.id), [1, 3])
        XCTAssertEqual(ProductCatalogFilter.apply(products, query: "10 мм", category: "Кольцо").map(\.id), [3])
        XCTAssertEqual(ProductCatalogFilter.apply(products, query: "cl-10", category: nil).map(\.id), [2, 3], "the product's article")
    }

    func testTileStockShowsTheStockOfOneSizeOrHowManySizesAreInStock() {
        let labret = SizeFixtures.labret()
        XCTAssertEqual(ProductTileText.stock(labret), "2 из 3 размеров")
        XCTAssertEqual(ProductTileText.accessibilityStock(labret), "в наличии 2 из 3 размеров")
        XCTAssertTrue(labret.lowStock, "8 мм is low: the tile highlights it")

        let allInStock = SizeFixtures.labret([SizeFixtures.six, SizeFixtures.variant(12, "8 мм", quantity: 3)])
        XCTAssertEqual(ProductTileText.stock(allInStock), "2 размера")
        let many = SizeFixtures.labret((1...5).map { SizeFixtures.variant($0, "\($0) мм", quantity: 2) })
        XCTAssertEqual(ProductTileText.stock(many), "5 размеров")
        let oneOfTwentyOne = SizeFixtures.labret((1...21).map { SizeFixtures.variant($0, "\($0) мм", quantity: $0 == 1 ? 1 : 0) })
        XCTAssertEqual(ProductTileText.stock(oneOfTwentyOne), "1 из 21 размера")

        let soldOut = SizeFixtures.labret([SizeFixtures.ten, SizeFixtures.variant(14, "12 мм", quantity: 0)])
        XCTAssertEqual(ProductTileText.stock(soldOut), "Нет")
        XCTAssertEqual(ProductTileText.accessibilityStock(soldOut), "нет в наличии")
        XCTAssertFalse(soldOut.isAvailable)

        XCTAssertEqual(ProductTileText.stock(SizeFixtures.ring(quantity: 4)), "4 шт")
        XCTAssertEqual(ProductTileText.accessibilityStock(SizeFixtures.ring(quantity: 4)), "осталось 4 шт")
        XCTAssertEqual(ProductTileText.stock(SizeFixtures.ring(quantity: 0)), "Нет")
    }

    func testSizeChipsShowPriceStockAndWhatIsInTheReceipt() throws {
        let labret = SizeFixtures.labret()
        let inReceipt = [12: 1]
        let options = SizeOption.options(for: labret) { inReceipt[$0] ?? 0 }

        XCTAssertEqual(options.map(\.id), [11, 12, 13], "in the staff's order")
        XCTAssertEqual(options.map(\.title), ["6 мм", "8 мм", "10 мм"])
        XCTAssertEqual(options.map(\.price), [1_500, 1_500, 1_700])
        XCTAssertEqual(options.map(\.stock), [.inStock, .low, .out])
        XCTAssertEqual(options.map(\.stockText), ["4 шт", "Мало: 1 шт", "Нет в наличии"])
        XCTAssertEqual(options.map(\.isAvailable), [true, true, false], "out-of-stock sizes cannot be picked")
        XCTAssertEqual(options.map(\.inReceiptText), [nil, "В чеке: 1", nil])
        XCTAssertEqual(options.map(\.isStockInReceipt), [false, true, false], "the only 8 мм is already in the receipt")
        XCTAssertEqual(options.map(\.canAdd), [true, false, false], "a chip adds only what the stock still has")
        XCTAssertTrue(SizeOption.showsPrices(options), "10 мм costs more: prices go on the chips")
        XCTAssertFalse(SizeOption.showsPrices(Array(options.prefix(2))))

        XCTAssertEqual(options[1].accessibilityLabel, "8 мм, \(Money.format(1_500)), мало: 1 шт, в чеке: 1")
        XCTAssertEqual(options[2].accessibilityLabel, "10 мм, \(Money.format(1_700)), нет в наличии")
    }

    func testAddedHintNamesTheSize() {
        XCTAssertEqual(SizePicking.addedHint(product: SizeFixtures.labret(), variant: SizeFixtures.eight), "Добавлено: Лабрет — 8 мм")
    }

    func testSizeLabelSplitsTheSizeOffTheNameForTheBadge() {
        let sized = SizeLabel.split(name: "Лабрет — 8 мм", size: "8 мм")
        XCTAssertEqual(sized.name, "Лабрет")
        XCTAssertEqual(sized.size, "8 мм")

        let older = SizeLabel.split(name: "Лабрет", size: "8 мм")
        XCTAssertEqual(older.name, "Лабрет", "a name without the size stays whole")
        XCTAssertEqual(older.size, "8 мм")

        let noSize = SizeLabel.split(name: "Лабрет — 8 мм", size: nil)
        XCTAssertEqual(noSize.name, "Лабрет — 8 мм")
        XCTAssertNil(noSize.size)
        XCTAssertNil(SizeLabel.split(name: "Кольцо", size: " ").size)

        XCTAssertEqual(SizeLabel.fullName(name: "Лабрет", size: "8 мм"), "Лабрет — 8 мм")
        XCTAssertEqual(SizeLabel.fullName(name: "Лабрет — 8 мм", size: "8 мм"), "Лабрет — 8 мм", "never doubled")
        XCTAssertEqual(SizeLabel.fullName(name: "Лабрет", size: nil), "Лабрет")
        XCTAssertEqual(SizeLabel.fullName(name: "Прокол мочки", size: ""), "Прокол мочки")
    }

    func testStockWarningNamesTheSize() {
        XCTAssertNil(ReceiptStock.warning(stock: 4, inReceipt: 4, lineQuantity: 4, sizeName: "6 мм"))
        XCTAssertEqual(
            ReceiptStock.warning(stock: 1, inReceipt: 2, lineQuantity: 2, sizeName: "8 мм"),
            "На складе только 1 шт размера 8 мм"
        )
        XCTAssertEqual(
            ReceiptStock.warning(stock: 1, inReceipt: 2, lineQuantity: 1, sizeName: "8 мм"),
            "На складе только 1 шт размера 8 мм — в чеке 2"
        )
        XCTAssertEqual(ReceiptStock.warning(stock: 0, inReceipt: 1, lineQuantity: 1, sizeName: "10 мм"), "Размера 10 мм нет на складе")
        XCTAssertEqual(ReceiptStock.warning(stock: 3, inReceipt: 5, lineQuantity: 5, sizeName: nil), "На складе только 3 шт")
        XCTAssertEqual(ReceiptStock.warning(stock: 0, inReceipt: 1, lineQuantity: 1, sizeName: nil), "Нет на складе")
    }

    func testTopProductSizeBreakdownListsNamedSizes() {
        let variants = [
            TopProductVariant(variantId: 12, name: "8 мм", quantity: 4, revenue: 6_000),
            TopProductVariant(variantId: 11, name: "6 мм", quantity: 3, revenue: 4_500),
        ]
        XCTAssertEqual(ReportText.sizeBreakdown(variants), "8 мм × 4 · 6 мм × 3")
        XCTAssertEqual(
            ReportText.sizeBreakdown(variants + [TopProductVariant(variantId: 2, name: "", quantity: 2, revenue: 3_000)]),
            "8 мм × 4 · 6 мм × 3",
            "the unnamed size of a product without sizes is left out"
        )
        XCTAssertNil(ReportText.sizeBreakdown([TopProductVariant(variantId: 2, name: "", quantity: 7, revenue: 10_500)]))
        XCTAssertNil(ReportText.sizeBreakdown([]), "a server that predates sizes")
    }

    func testRefundRestockNoteNamesTheSoldSizes() {
        let sized = SaleItem(
            id: 1, type: .product, productId: 1, variantId: 12, variantName: "8 мм", serviceId: nil,
            name: "Лабрет — 8 мм", quantity: 2, price: 1_500, total: 3_000
        )
        let older = SaleItem(
            id: 2, type: .product, productId: 1, variantId: 11, variantName: "6 мм", serviceId: nil,
            name: "Лабрет", quantity: 1, price: 1_500, total: 1_500
        )
        let plain = SaleItem(
            id: 3, type: .product, productId: 2, variantId: 2, variantName: nil, serviceId: nil,
            name: "Кольцо-кликер", quantity: 1, price: 2_800, total: 2_800
        )
        let service = SaleItem(id: 4, type: .service, productId: nil, serviceId: 3, name: "Прокол", quantity: 1, price: 2_500, total: 2_500)

        XCTAssertEqual(
            SaleRefundText.restockNote([sized, older, plain, service]),
            "Украшения вернутся на склад в проданные размеры: Лабрет — 8 мм × 2, Лабрет — 6 мм. "
                + "Выключите, если украшение использовано или повреждено."
        )
        XCTAssertEqual(SaleRefundText.restockNote([plain, service]), SaleRefundText.restockHint, "no sizes to name")
    }
}
