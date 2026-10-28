import Foundation
import Testing
@testable import MIKAN

/// A catalog with masters' own prices (docs/API.md «Service» `masterPrices`): Анна (2) charges the catalog price,
/// Амина (3) her own.
@MainActor
private enum PricingSample {
    static let start = Date(timeIntervalSince1970: 1_792_062_000) // 2026-10-15 11:00 UTC
    static let anna = 2
    static let amina = 3

    static let lobe = Service(
        id: 3, name: "Прокол мочки", category: .piercing, group: "Ухо", price: 1_600, priceFrom: false,
        durationMin: 30, masterPrices: [ServiceMasterPrice(employeeId: amina, price: 2_000, priceMax: nil)],
        aftercareTemplateId: nil, active: true, sort: 0
    )
    static let nipple = Service(
        id: 5, name: "Соски", category: .piercing, group: "Тело", price: 2_500, priceFrom: false, durationMin: 45,
        variants: [
            ServiceVariant(name: "Один", price: 2_500, durationMin: nil),
            ServiceVariant(name: "Два", price: 4_000, durationMin: 60),
        ],
        depositAmount: 500,
        masterPrices: [ServiceMasterPrice(
            employeeId: amina, price: 2_500, priceMax: nil, variants: [ServiceMasterVariantPrice(name: "Два", price: 5_000)]
        )],
        aftercareTemplateId: nil, active: true, sort: 1
    )
    static let tattoo = Service(
        id: 4, name: "Мини тату", category: .tattoo, group: nil, price: 2_000, priceMax: nil, priceFrom: false,
        durationMin: 60, masterPrices: [ServiceMasterPrice(employeeId: amina, price: 3_000, priceMax: 6_000)],
        aftercareTemplateId: nil, active: true, sort: 2
    )
    static let catalog = [lobe, nipple, tattoo]

    static let client = ClientRef(id: 1, name: "Иван Петров", phone: "+79991234567", telegramLinked: true)

    static func line(id: Int, service: Service, name: String? = nil, price: Int) -> AppointmentServiceLine {
        AppointmentServiceLine(
            id: id, serviceId: service.id, name: name ?? service.name, category: service.category, price: price,
            durationMin: service.durationMin
        )
    }

    static func appointment(masterId: Int, lines: [AppointmentServiceLine], price: Int? = nil) -> Appointment {
        Appointment(
            id: 7, client: client, master: EmployeeRef(id: masterId, name: "Мастер", color: nil), service: nil,
            services: lines, title: nil, startsAt: start, endsAt: start.addingTimeInterval(3_600), status: .scheduled,
            price: price ?? lines.reduce(0) { $0 + $1.price }, deposit: 0, depositRequired: 300, notes: nil, saleId: nil,
            completedAt: nil, createdAt: start, updatedAt: start
        )
    }
}

@MainActor
struct AppointmentMasterPricingTests {
    private typealias S = PricingSample

    @Test("A booked line takes the master's price, the variant's own one too; no master — the catalog price")
    func bookingUsesMasterPrice() throws {
        var draft = AppointmentDraft.new(at: S.start, masterId: S.amina)
        draft.add(service: S.lobe)
        draft.add(service: S.nipple, variant: S.nipple.variants[1])
        draft.add(service: S.nipple, variant: S.nipple.variants[0])
        #expect(draft.lines.map(\.price) == [2_000, 5_000, 2_500])
        #expect(draft.lines.map(\.variant) == [nil, "Два", "Один"])
        #expect(draft.total == 9_500)

        let anyone = DraftServiceLine(service: S.lobe)
        #expect(anyone.price == 1_600)
        #expect(anyone.autoPrice == 1_600)
    }

    @Test("A master's own maximum makes the line variable; «от» stays the service's")
    func variablePriceForMaster() {
        #expect(!S.tattoo.hasVariablePrice(for: S.anna))
        #expect(S.tattoo.hasVariablePrice(for: S.amina))
        #expect(DraftServiceLine(service: S.tattoo, masterId: S.amina).isVariablePrice)
        #expect(!S.lobe.hasVariablePrice(for: S.amina))
    }

    @Test("Another master re-prices the untouched lines; a hand-set price and a custom line stay")
    func masterChangeReprices() throws {
        var draft = AppointmentDraft.new(at: S.start, masterId: S.anna)
        draft.add(service: S.lobe)
        draft.add(service: S.nipple, variant: S.nipple.variants[1])
        draft.add(service: S.tattoo)
        draft.addCustom(name: "Подбор украшения", price: 300)
        draft.lines[2].price = 2_400
        #expect(draft.lines.map(\.price) == [1_600, 4_000, 2_400, 300])

        draft.masterId = S.amina
        draft.repriceLines(from: S.catalog)
        #expect(draft.lines.map(\.price) == [2_000, 5_000, 2_400, 300])
        #expect(draft.total == 9_700)
        #expect(draft.depositRequired == 500, "the prepayment follows the services, not the master")

        draft.masterId = S.anna
        draft.repriceLines(from: S.catalog)
        #expect(draft.lines.map(\.price) == [1_600, 4_000, 2_400, 300], "switching back restores the prices")
    }

    @Test("Lines added before a master is chosen take the master's prices once chosen")
    func linesBeforeMaster() {
        var draft = AppointmentDraft.new(day: S.start, client: S.client)
        draft.add(service: S.lobe)
        draft.add(service: S.tattoo)
        #expect(draft.total == 3_600)

        draft.masterId = S.amina
        draft.repriceLines(from: S.catalog)
        #expect(draft.lines.map(\.price) == [2_000, 3_000])
        #expect(draft.lines[1].isVariablePrice)
        #expect(draft.body(force: false)?.price == 5_000)
    }

    @Test("Saved lines re-price only while their price equals the old master's catalog price")
    func savedLinesRepriceWhenUntouched() throws {
        let appointment = S.appointment(masterId: S.anna, lines: [
            S.line(id: 1, service: S.lobe, price: 1_600),
            S.line(id: 2, service: S.nipple, name: "Соски — Два", price: 4_000),
            S.line(id: 3, service: S.tattoo, price: 2_500),
        ])
        var draft = AppointmentDraft.edit(appointment, catalog: S.catalog)
        #expect(draft.lines.map(\.variant) == [nil, "Два", nil])
        #expect(draft.lines.map(\.followsCatalog) == [true, true, false])

        draft.masterId = S.amina
        draft.repriceLines(from: S.catalog)
        #expect(draft.lines.map(\.price) == [2_000, 5_000, 2_500])
        #expect(draft.total == 9_500)
    }

    @Test("A catalog loaded later prices saved lines for the saved master, then for the current one")
    func resolveCatalogLater() throws {
        let appointment = S.appointment(masterId: S.amina, lines: [
            S.line(id: 1, service: S.lobe, price: 2_000),
            S.line(id: 2, service: S.tattoo, price: 4_500),
        ])
        var draft = AppointmentDraft.edit(appointment)
        #expect(draft.lines.allSatisfy { $0.autoPrice == nil })

        // The editor may set the master before the catalog arrives.
        draft.masterId = S.anna
        draft.repriceLines(from: [])
        draft.resolveCatalog(from: S.catalog)
        #expect(draft.lines.map(\.price) == [1_600, 4_500])
        #expect(draft.lines.map(\.depositAmount) == [0, 0])
    }

    @Test("The same master keeps saved prices, even when the catalog changed since")
    func sameMasterKeepsSavedPrices() {
        let appointment = S.appointment(masterId: S.amina, lines: [S.line(id: 1, service: S.lobe, price: 1_800)], price: 1_800)
        var draft = AppointmentDraft.edit(appointment)
        draft.resolveCatalog(from: S.catalog)
        #expect(draft.lines.map(\.price) == [1_800])
        #expect(draft.lines.first?.followsCatalog == false)
    }

    @Test("Lines of a missing service or a renamed variant never re-price")
    func unmatchedLinesStay() {
        let appointment = S.appointment(masterId: S.anna, lines: [
            AppointmentServiceLine(id: 1, serviceId: 99, name: "Старая услуга", category: .other, price: 1_000, durationMin: 30),
            S.line(id: 2, service: S.nipple, name: "Соски — Три", price: 2_500),
        ])
        var draft = AppointmentDraft.edit(appointment, catalog: S.catalog)
        draft.masterId = S.amina
        draft.repriceLines(from: S.catalog)
        #expect(draft.lines.map(\.price) == [1_000, 2_500])
        #expect(draft.lines.allSatisfy { $0.autoPrice == nil })
    }

    // MARK: - Calendar move

    private func move(_ appointment: Appointment, to masterId: Int) -> AppointmentMove {
        AppointmentMove(
            appointment: appointment,
            target: DragTarget(
                column: 1, startMinute: 0, startsAt: appointment.startsAt, endsAt: appointment.endsAt, masterId: masterId
            )
        )
    }

    @Test("A drop on another master sends the re-priced lines, the new total and the kept prepayment")
    func moveReprices() throws {
        let appointment = S.appointment(masterId: S.anna, lines: [
            S.line(id: 1, service: S.lobe, price: 1_600),
            S.line(id: 2, service: S.tattoo, price: 2_500),
        ])
        let moved = move(appointment, to: S.amina)
        let repricing = try #require(moved.repricing(catalog: S.catalog))
        #expect(repricing.services.map(\.price) == [2_000, 2_500])
        #expect(repricing.price == 4_500)

        let body = moved.body(notifyClient: false, force: false, repricing: repricing)
        #expect(body.masterId == S.amina)
        #expect(body.services == repricing.services)
        #expect(body.price == 4_500)
        #expect(body.depositRequired == 300)
    }

    @Test("No new prices: the same master, an empty catalog or nothing to re-price — the move sends only the time")
    func moveWithoutRepricing() throws {
        let appointment = S.appointment(masterId: S.anna, lines: [S.line(id: 1, service: S.tattoo, price: 2_500)])
        #expect(move(appointment, to: S.anna).repricing(catalog: S.catalog) == nil)
        #expect(move(appointment, to: S.amina).repricing(catalog: []) == nil)
        #expect(move(appointment, to: S.amina).repricing(catalog: S.catalog) == nil, "a hand-set price stays")

        let body = move(appointment, to: S.amina).body(notifyClient: false, force: false)
        let json = try #require(JSONSerialization.jsonObject(with: JSONCoding.makeEncoder().encode(body)) as? [String: Any])
        #expect(json["services"] == nil)
        #expect(json["price"] == nil)
        #expect(json["depositRequired"] == nil)
    }
}
