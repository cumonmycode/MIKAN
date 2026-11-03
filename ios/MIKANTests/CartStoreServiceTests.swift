import XCTest
@testable import MIKAN

@MainActor
final class CartStoreServiceTests: XCTestCase {
    /// Isolated UserDefaults domain per test, so the remembered payment method never leaks between tests.
    private lazy var suiteName: String = {
        let name = "CartStoreServiceTests.\(UUID().uuidString)"
        addTeardownBlock { UserDefaults.standard.removePersistentDomain(forName: name) }
        return name
    }()

    private func makeCart() throws -> CartStore {
        CartStore(defaults: try XCTUnwrap(UserDefaults(suiteName: suiteName)))
    }

    private let nipple = Service(
        id: 5, name: "Соски", category: .piercing, group: "Тело", price: 2_500, priceFrom: false, durationMin: 45,
        variants: [
            ServiceVariant(name: "Один", price: 2_500, durationMin: nil),
            ServiceVariant(name: "Два", price: 4_000, durationMin: 60),
        ],
        active: true, sort: 0
    )

    private let tattoo = Service(
        id: 4, name: "Мини тату", category: .tattoo, price: 2_000, priceMax: 5_000, priceFrom: true,
        durationMin: 60, active: true, sort: 1
    )

    private func line(id: Int, serviceId: Int?, name: String, price: Int) -> AppointmentServiceLine {
        AppointmentServiceLine(id: id, serviceId: serviceId, name: name, category: .piercing, price: price, durationMin: nil)
    }

    private func appointment(price: Int, deposit: Int, services: [AppointmentServiceLine]) -> Appointment {
        Appointment(
            id: 7,
            client: ClientRef(id: 1, name: "Иван Петров", phone: nil, telegramLinked: false),
            master: EmployeeRef(id: 2, name: "Анна", color: nil),
            service: ServiceRef(id: 3, name: "Прокол мочки", category: .piercing),
            services: services,
            title: "Пирсинг",
            startsAt: Fixtures.referenceDate, endsAt: Fixtures.referenceDate.addingTimeInterval(3_600),
            status: .completed, price: price, deposit: deposit, notes: nil, saleId: nil, completedAt: nil,
            createdAt: Fixtures.referenceDate, updatedAt: Fixtures.referenceDate
        )
    }

    // MARK: - add(service:variant:)

    func testAddServiceVariantUsesVariantNameAndPrice() throws {
        let cart = try makeCart()

        cart.add(service: nipple, variant: nipple.variants[1])

        let added = try XCTUnwrap(cart.lines.first)
        XCTAssertEqual(added.name, "Соски — Два")
        XCTAssertEqual(added.unitPrice, 4_000)
        XCTAssertEqual(added.kind, .service(id: 5))
        XCTAssertEqual(cart.subtotal, 4_000)
        let body = try XCTUnwrap(cart.makeSaleBody().items.first)
        XCTAssertEqual(body.serviceId, 5)
        XCTAssertEqual(body.name, "Соски — Два")
        XCTAssertEqual(body.price, 4_000)
    }

    func testAddServiceWithoutVariantUsesBasePrice() throws {
        let cart = try makeCart()

        cart.add(service: tattoo)

        let added = try XCTUnwrap(cart.lines.first)
        XCTAssertEqual(added.name, "Мини тату")
        XCTAssertEqual(added.unitPrice, 2_000, "variable-price services start at their base price")
        XCTAssertEqual(added.kind, .service(id: 4))
    }

    func testRepeatedServiceBumpsQuantityButVariantsAndEditedPricesStaySeparate() throws {
        let cart = try makeCart()

        cart.add(service: nipple, variant: nipple.variants[0])
        cart.add(service: nipple, variant: nipple.variants[0])
        cart.add(service: nipple, variant: nipple.variants[1])
        XCTAssertEqual(cart.lines.map(\.name), ["Соски — Один", "Соски — Два"])
        XCTAssertEqual(cart.lines.map(\.quantity), [2, 1])
        XCTAssertEqual(cart.quantity(ofService: 5), 3)

        cart.lines[1].unitPrice = 4_500
        cart.add(service: nipple, variant: nipple.variants[1])
        XCTAssertEqual(cart.lines.count, 3, "a line repriced in the receipt is not merged")
        XCTAssertEqual(cart.subtotal, 2 * 2_500 + 4_500 + 4_000)
    }

    func testAddServiceTakesTheMastersOwnPrice() throws {
        let cart = try makeCart()
        var priced = nipple
        priced.masterPrices = [
            ServiceMasterPrice(employeeId: 9, price: 3_000, variants: [ServiceMasterVariantPrice(name: "Два", price: 5_000)]),
        ]

        cart.add(service: priced, variant: priced.variants[1], masterId: 9)
        cart.add(service: priced, variant: priced.variants[0], masterId: 9)
        cart.add(service: priced, masterId: 9)
        cart.add(service: priced, masterId: 2)

        XCTAssertEqual(cart.lines.map(\.unitPrice), [5_000, 2_500, 3_000, 2_500], "own variant, catalog variant, own, catalog")
        XCTAssertEqual(cart.quantity(ofService: 5, named: "Соски — Два"), 1)
        XCTAssertEqual(cart.quantity(ofService: 5, named: "Соски"), 2)
    }

    // MARK: - prefill(from:)

    func testPrefillSplitsServiceLinesWhenTheyAddUpToThePrice() throws {
        let cart = try makeCart()
        let booked = [
            line(id: 1, serviceId: 3, name: "Прокол мочки", price: 1_600),
            line(id: 2, serviceId: nil, name: "Своя услуга", price: 900),
        ]

        cart.prefill(from: appointment(price: 2_500, deposit: 0, services: booked))

        XCTAssertEqual(cart.lines.map(\.name), ["Прокол мочки", "Своя услуга"])
        XCTAssertEqual(cart.lines.map(\.unitPrice), [1_600, 900])
        XCTAssertEqual(cart.lines.map(\.kind), [.service(id: 3), .service(id: nil)])
        XCTAssertEqual(cart.lines.map(\.quantity), [1, 1])
        XCTAssertEqual(cart.total, 2_500)
        XCTAssertEqual(cart.makeSaleBody().items.map(\.serviceId), [3, nil])
    }

    func testPrefillFallsBackToOneLineWhenThePriceWasChanged() throws {
        let cart = try makeCart()
        let booked = [
            line(id: 1, serviceId: 3, name: "Прокол мочки", price: 1_600),
            line(id: 2, serviceId: 5, name: "Соски — Один", price: 2_500),
        ]

        cart.prefill(from: appointment(price: 3_000, deposit: 0, services: booked))

        let only = try XCTUnwrap(cart.lines.first)
        XCTAssertEqual(cart.lines.count, 1)
        XCTAssertEqual(only.name, "Прокол мочки, Соски — Один")
        XCTAssertEqual(only.unitPrice, 3_000)
        XCTAssertEqual(only.kind, .service(id: 3), "the legacy service id is kept")
        XCTAssertEqual(cart.total, 3_000)
    }

    func testPrefillWithoutServiceLinesKeepsOneLineAtTheAppointmentPrice() throws {
        let cart = try makeCart()

        cart.prefill(from: appointment(price: 8_000, deposit: 0, services: []))

        let only = try XCTUnwrap(cart.lines.first)
        XCTAssertEqual(cart.lines.count, 1)
        XCTAssertEqual(only.name, "Прокол мочки")
        XCTAssertEqual(only.unitPrice, 8_000)
        XCTAssertEqual(only.kind, .service(id: 3))
    }

    func testPrefillKeepsClientAppointmentAndDeposit() throws {
        let cart = try makeCart()
        cart.add(service: tattoo)
        cart.discount = 300
        let booked = [
            line(id: 1, serviceId: 3, name: "Прокол мочки", price: 1_600),
            line(id: 2, serviceId: 5, name: "Соски — Два", price: 4_000),
        ]

        cart.prefill(from: appointment(price: 5_600, deposit: 1_000, services: booked))

        XCTAssertEqual(cart.lines.count, 2, "previous cart content is replaced")
        XCTAssertEqual(cart.discount, 0)
        XCTAssertEqual(cart.deposit, 1_000)
        XCTAssertEqual(cart.depositApplied, 1_000)
        XCTAssertEqual(cart.amountDue, 4_600)
        XCTAssertEqual(cart.split, PaymentSplit(cash: 4_600), "the prepayment is not a method's share")
        cart.selectPaymentMode(.single(.card))
        XCTAssertEqual(cart.split, PaymentSplit(card: 4_600))
        XCTAssertTrue(cart.canSubmit)

        let body = cart.makeSaleBody()
        XCTAssertEqual(body.clientId, 1)
        XCTAssertEqual(body.appointmentId, 7)
        XCTAssertEqual(body.items.map(\.price), [1_600, 4_000])
        XCTAssertEqual(body.payments, Payments(cash: 0, card: 4_600, transfer: 0, qr: 0, deposit: 1_000))
    }

    func testPrefillKeepsTheWholeHeldPrepayment() throws {
        let cart = try makeCart()
        let booked = [line(id: 1, serviceId: 3, name: "Прокол мочки", price: 1_600)]

        cart.prefill(from: appointment(price: 1_600, deposit: 5_000, services: booked))

        XCTAssertEqual(cart.deposit, 5_000)
        XCTAssertEqual(cart.depositApplied, 1_600)
        XCTAssertEqual(cart.depositRemainder, 3_400)
        XCTAssertEqual(cart.amountDue, 0)
        XCTAssertEqual(cart.split, PaymentSplit())
        XCTAssertTrue(cart.canSubmit)
        XCTAssertEqual(cart.makeSaleBody().payments, Payments(cash: 0, card: 0, transfer: 0, qr: 0, deposit: 1_600))
    }
}

/// Service catalog filtering / grouping in the POS and the client history summary.
final class POSServiceCatalogAndHistoryTests: XCTestCase {
    private func service(
        _ id: Int, _ name: String, _ category: ServiceCategory, group: String?, description: String? = nil, sort: Int? = nil
    ) -> Service {
        Service(
            id: id, name: name, category: category, group: group, price: 1_000, priceFrom: false, durationMin: 30,
            description: description, active: true, sort: sort ?? id
        )
    }

    private func entry(_ id: String, kind: HistoryEntryKind, quantity: Int = 1, total: Int, refunded: Bool = false) -> HistoryEntry {
        HistoryEntry(
            id: id, kind: kind, date: Fixtures.referenceDate, name: "Позиция", serviceId: nil, productId: nil,
            quantity: quantity, price: total / max(1, quantity), total: total, client: nil, employee: nil,
            appointmentId: nil, saleId: nil, saleNumber: nil, refunded: refunded
        )
    }

    func testFilterMatchesNameGroupDescriptionAndCategory() {
        let services = [
            service(1, "Хеликс", .piercing, group: "Ухо"),
            service(2, "Мини тату", .tattoo, group: "Тату", description: "До 5 см"),
            service(3, "Мочка", .piercing, group: "Ухо"),
        ]

        XCTAssertEqual(POSServiceCatalog.filter(services, category: nil, query: " ухо ").map(\.id), [1, 3])
        XCTAssertEqual(POSServiceCatalog.filter(services, category: nil, query: "5 см").map(\.id), [2])
        XCTAssertEqual(POSServiceCatalog.filter(services, category: .tattoo, query: "").map(\.id), [2])
        XCTAssertEqual(POSServiceCatalog.filter(services, category: .piercing, query: "мини").map(\.id), [])
        XCTAssertEqual(POSServiceCatalog.categories(of: services), [.tattoo, .piercing])
    }

    func testSectionsFollowCategoryOrderThenGroupsInSortOrderWithUngroupedLast() {
        let services = [
            service(1, "Мочка", .piercing, group: nil, sort: 0),
            service(2, "Хеликс", .piercing, group: "Ухо", sort: 5),
            service(3, "Бровь", .piercing, group: "Лицо", sort: 2),
            service(4, "Мини тату", .tattoo, group: "Тату", sort: 9),
            service(5, "Удаление", .tattoo, group: "Коррекция и удаление", sort: 10),
            service(6, "Трагус", .piercing, group: "Ухо", sort: 1),
            service(7, "Консультация", .other, group: nil, sort: 3),
        ]

        let sections = POSServiceCatalog.sections(services)

        XCTAssertEqual(sections.map(\.category), [.tattoo, .tattoo, .piercing, .piercing, .piercing, .other])
        XCTAssertEqual(sections.map(\.group), ["Тату", "Коррекция и удаление", "Ухо", "Лицо", "Другое", nil])
        XCTAssertEqual(sections.map { $0.services.map(\.id) }, [[4], [5], [6, 2], [3], [1], [7]])
        XCTAssertEqual(sections.map(\.isFirstInCategory), [true, false, true, false, false, true])
    }

    func testSectionHeadersShowCategoriesOnlyWhenSeveralAndSkipARepeatedGroupTitle() {
        let services = [
            service(1, "Мини тату", .tattoo, group: "Тату"),
            service(2, "Удаление", .tattoo, group: "Коррекция и удаление"),
            service(3, "Мочка", .piercing, group: nil),
        ]
        let sections = POSServiceCatalog.sections(services)

        let headers = sections.map { $0.headers(showsCategories: true) }
        XCTAssertEqual(headers.map(\.category), ["Тату", nil, "Пирсинг"])
        XCTAssertEqual(headers.map(\.group), [nil, "Коррекция и удаление", nil], "group «Тату» repeats the category title")

        let tattooOnly = POSServiceCatalog.sections(services.filter { $0.category == .tattoo })
        let single = tattooOnly.map { $0.headers(showsCategories: false) }
        XCTAssertEqual(single.map(\.category), [nil, nil])
        XCTAssertEqual(single.map(\.group), ["Тату", "Коррекция и удаление"])
    }

    func testPriceHintOnlyForVariablePriceWithoutVariant() {
        var fixed = service(1, "Мочка", .piercing, group: "Ухо")
        XCTAssertNil(POSServiceCatalog.priceHint(for: fixed, variant: nil))
        fixed.priceFrom = true
        XCTAssertNotNil(POSServiceCatalog.priceHint(for: fixed, variant: nil))
        XCTAssertNil(POSServiceCatalog.priceHint(for: fixed, variant: ServiceVariant(name: "Два", price: 2_000, durationMin: nil)))
    }

    func testPriceHintNamesTheMastersPriceAndTheirOwnRange() {
        var lobe = service(1, "Мочка", .piercing, group: "Ухо")
        lobe.masterPrices = [ServiceMasterPrice(employeeId: 9, price: 1_800, priceMax: 2_500)]

        XCTAssertNil(POSServiceCatalog.priceHint(for: lobe, variant: nil, masterId: 2), "a fixed catalog price")
        XCTAssertEqual(
            POSServiceCatalog.priceHint(for: lobe, variant: nil, masterId: 9),
            "Добавлено по \(Money.format(1_800)) — итоговую цену можно изменить в чеке"
        )
    }

    func testHistorySummaryLeavesRefundsOutAndCountsThemSeparately() {
        let entries = [
            entry("as1", kind: .service, total: 1_600),
            entry("as2", kind: .service, total: 4_000, refunded: true),
            entry("si1", kind: .product, quantity: 2, total: 3_000),
        ]

        let services = HistorySummary(entries: [entries[0], entries[1]])
        XCTAssertEqual(services.count, 1)
        XCTAssertEqual(services.total, 1_600)
        XCTAssertEqual(services.refundedCount, 1)
        XCTAssertEqual(services.text(for: .service), "1 услуга · \(Money.format(1_600)) · возвратов: 1")

        let products = HistorySummary(entries: [entries[2]])
        XCTAssertEqual(products.count, 2, "quantities are counted")
        XCTAssertEqual(products.refundedCount, 0)
        XCTAssertEqual(products.text(for: .product), "2 товара · \(Money.format(3_000))")
    }
}
