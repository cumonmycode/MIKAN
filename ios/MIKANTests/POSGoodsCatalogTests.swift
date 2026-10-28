import Foundation
import Testing
@testable import MIKAN

/// «Товары» in the POS receipt: its own segment with search and category chips, goods lines with a bag icon.
@MainActor
struct POSGoodsCatalogTests {
    private let labret = InventoryFixtures.labret
    private let ring = InventoryFixtures.product(id: 2, name: "Кольцо", category: "Кольцо", quantity: 2)
    private let spray = InventoryFixtures.product(
        id: 21, kind: .goods, name: "Спрей для ухода", sku: "SPR-50", category: "Уход",
        variants: [InventoryFixtures.size(31, "50 мл", quantity: 6), InventoryFixtures.size(32, "100 мл", quantity: 1, price: 1_400)]
    )
    private let card = InventoryFixtures.product(id: 22, kind: .goods, name: "Подарочный сертификат", category: "Сертификаты", quantity: 10)
    private let pin = InventoryFixtures.product(id: 23, kind: .goods, name: "Значок MIKAN", quantity: 5)
    private var catalog: [Product] { [labret, ring, spray, card, pin] }

    private let registry = [
        CatalogCategory(id: 1, section: .goods, serviceCategory: nil, name: "Сертификаты", position: 0, itemCount: 1),
        CatalogCategory(id: 2, section: .goods, serviceCategory: nil, name: "Уход", position: 1, itemCount: 1),
        CatalogCategory(id: 3, section: .goods, serviceCategory: nil, name: "Пусто", position: 2, itemCount: 0),
        CatalogCategory(id: 4, section: .jewelry, serviceCategory: nil, name: "Лабрет", position: 0, itemCount: 1),
    ]

    @Test("Segments: «Товары» sells goods, services have no product kind")
    func segments() {
        #expect(POSCatalog.allCases.map(\.title) == ["Украшения", "Услуги", "Товары"])
        #expect(POSCatalog.goods.productKind == .goods)
        #expect(POSCatalog.jewelry.productKind == .jewelry)
        #expect(POSCatalog.services.productKind == nil)
        #expect(POSCatalog(rawValue: POSCatalog.goods.rawValue) == .goods, "the remembered segment reads back")
    }

    @Test("Each segment lists only its kind; search and the category work inside it")
    func filtering() {
        #expect(ProductCatalogFilter.apply(catalog, kind: .goods, query: "", category: nil).map(\.id) == [21, 22, 23])
        #expect(ProductCatalogFilter.apply(catalog, kind: .jewelry, query: "", category: nil).map(\.id) == [1, 2])
        #expect(ProductCatalogFilter.apply(catalog, kind: .goods, query: "100 мл", category: nil).map(\.id) == [21], "a size name")
        #expect(ProductCatalogFilter.apply(catalog, kind: .goods, query: "кольцо", category: nil).isEmpty, "jewelry is not in goods")
        #expect(ProductCatalogFilter.apply(catalog, kind: .goods, query: "", category: "Уход").map(\.id) == [21])
        #expect(
            ProductCatalogFilter.apply(catalog, kind: .goods, query: "", category: "Лабрет").map(\.id) == [21, 22, 23],
            "a chip of another segment (or one that vanished) filters nothing"
        )
    }

    @Test("Category chips follow the warehouse order of the section and skip empty categories")
    func chips() {
        #expect(ProductCatalogFilter.categories(of: catalog, kind: .goods, registry: registry) == ["Сертификаты", "Уход"])
        #expect(ProductCatalogFilter.categories(of: catalog, kind: .jewelry, registry: registry) == ["Лабрет", "Кольцо"])
        #expect(ProductCatalogFilter.categories(of: catalog, kind: .goods, registry: []) == ["Сертификаты", "Уход"], "alphabetical without the registry")
    }

    @Test("Pickers group by category in chip order, «Без категории» last")
    func grouping() {
        let goods = ProductCatalogFilter.products(catalog, kind: .goods)
        let groups = ProductCatalogFilter.grouped(goods, categories: ["Уход", "Сертификаты"])
        #expect(groups.map(\.title) == ["Уход", "Сертификаты", "Без категории"])
        #expect(groups.last?.products.map(\.id) == [23])
        #expect(ProductCatalogFilter.grouped([], categories: ["Уход"]).isEmpty)
    }

    @Test("Goods go into the receipt like jewelry, sized, with a bag icon")
    func goodsLines() throws {
        let cart = CartStore(defaults: try #require(UserDefaults(suiteName: "POSGoodsCatalogTests")))
        #expect(!cart.add(product: spray), "several sizes need a size")
        #expect(cart.add(product: spray, variant: spray.variants[1]))
        #expect(cart.add(product: card))
        #expect(cart.add(product: labret, variant: labret.variants[0]))
        cart.add(service: Service(
            id: 3, name: "Хеликс", category: .piercing, group: nil, price: 2_500, priceFrom: false, durationMin: 30,
            active: true, sort: 0
        ))
        #expect(cart.lines.map(\.symbol) == ["bag", "bag", "sparkles", "hands.and.sparkles"])
        #expect(cart.lines[0].name == "Спрей для ухода — 100 мл")
        #expect(cart.lines[0].unitPrice == 1_400)
        #expect(cart.makeSaleBody().items[0].variantId == 32, "the sale names the size, as for jewelry")
    }
}
