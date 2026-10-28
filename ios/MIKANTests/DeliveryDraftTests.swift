import Foundation
import Testing
@testable import MIKAN

private typealias F = InventoryFixtures

/// Deliveries (`POST /stock/deliveries`): what a delivery takes, adding sizes, the cost pre-fill, totals, validation,
/// the request, the picker search, supplier suggestions and how a delivery receipt reads in the movements.
struct DeliveryDraftTests {
    private static let nbsp = "\u{00A0}"

    /// Лабрет (cost 600): 6 мм, 8 мм, 10 мм (own cost 700).
    private let labret = F.labret
    private let needles = F.product(
        id: 9, kind: .consumable, name: "Иглы 1.2", category: "Иглы", supplier: "Kwadron", price: 0, cost: 40, unit: "уп",
        variants: [F.size(19, "", quantity: 50)]
    )
    private let spray = F.product(id: 7, kind: .goods, name: "Спрей", cost: nil, variants: [F.size(17, "", quantity: 3)])
    private let gloves = F.presence(id: 16, name: "Перчатки", status: .ok)

    // MARK: - Adding

    @Test("Presence consumables are bought by sum, not received in a delivery")
    func acceptedProducts() {
        #expect(DeliveryDraft.accepts(labret))
        #expect(DeliveryDraft.accepts(needles))
        #expect(!DeliveryDraft.accepts(gloves))
        #expect(DeliveryDraft().adding(gloves, variantId: 1600).isEmpty)
    }

    @Test("A tap adds a unit; the same size again adds on top; the cost is the size's own, else the product's")
    func addingUnits() throws {
        let draft = DeliveryDraft()
            .adding(labret, variantId: 5)
            .adding(labret, variantId: 1, quantity: 2)
            .adding(labret, variantId: 5)
        #expect(draft.lines.map(\.variantId) == [5, 1])
        #expect(draft.line(variantId: 5)?.quantity == 2)
        #expect(draft.line(variantId: 5)?.unitCost == 700, "the 10 мм size has its own cost")
        #expect(draft.line(variantId: 1)?.unitCost == 600)
        #expect(draft.line(variantId: 1)?.title == "Лабрет — 6 мм")
        #expect(draft.quantity(ofProduct: labret.id) == 4)
        #expect(draft.adding(labret, variantId: 99) == draft, "an unknown size changes nothing")
        #expect(draft.adding(labret, variantId: 1, quantity: 0) == draft)
        let spray = try #require(DeliveryDraft().adding(spray, variantId: 17).lines.first)
        #expect(spray.unitCost == nil, "no cost known: received without one")
        #expect(spray.title == "Спрей")
    }

    @Test("The sizes screen sets each size: new ones follow in size order, an emptied one leaves")
    func settingSizes() {
        var draft = DeliveryDraft().adding(needles, variantId: 19).adding(labret, variantId: 4)
        draft = draft.settingUnitCost(650, forLine: 4)
        draft = draft.settingQuantities([1: 3, 4: 5, 5: 0], of: labret)
        #expect(draft.lines.map(\.variantId) == [19, 4, 1])
        #expect(draft.line(variantId: 4)?.quantity == 5)
        #expect(draft.line(variantId: 4)?.unitCost == 650, "a size already there keeps its typed cost")
        #expect(draft.line(variantId: 1)?.quantity == 3)

        draft = draft.settingQuantities([1: 3], of: labret)
        #expect(draft.lines.map(\.variantId) == [19, 1])
        #expect(draft.settingQuantities([1: 3], of: labret) == draft, "applying the same again changes nothing")
    }

    @Test("Lines can be removed and edited")
    func editingLines() {
        let draft = DeliveryDraft().adding(labret, variantId: 1).adding(labret, variantId: 4).adding(needles, variantId: 19)
        #expect(draft.removingLines(at: IndexSet(integer: 1)).lines.map(\.variantId) == [1, 19])
        #expect(draft.settingQuantity(nil, forLine: 19).line(variantId: 19)?.quantity == nil)
        #expect(draft.settingUnitCost(nil, forLine: 1).line(variantId: 1)?.unitCost == nil)
        #expect(draft.settingQuantity(5, forLine: 99) == draft)
    }

    // MARK: - Totals

    @Test("Totals: positions, units and the sum of the lines with a cost")
    func totals() {
        let draft = DeliveryDraft()
            .adding(labret, variantId: 1, quantity: 4)
            .adding(labret, variantId: 5, quantity: 2)
            .adding(spray, variantId: 17, quantity: 3)
        #expect(draft.positions == 3)
        #expect(draft.units == 9)
        #expect(draft.total == 4 * 600 + 2 * 700)
        #expect(draft.uncostedLines == 1)
        #expect(draft.commonUnit == "шт")
        #expect(draft.adding(needles, variantId: 19).commonUnit == nil, "шт and уп")
        #expect(DeliveryText.summary(positions: 3, units: 9, unit: "шт") == "3 позиции · 9 шт")
        #expect(DeliveryText.summary(positions: 1, units: 14, unit: nil) == "1 позиция · 14 единиц")
    }

    // MARK: - Validation and request

    @Test("Validation: something to receive, quantities, limits")
    func validation() {
        #expect(DeliveryDraft().validationMessage == "Добавьте хотя бы одну позицию.")
        let draft = DeliveryDraft().adding(labret, variantId: 4)
        #expect(draft.canSubmit)
        #expect(draft.settingQuantity(nil, forLine: 4).validationMessage == "Укажите количество: Лабрет — 8 мм.")
        #expect(draft.settingQuantity(0, forLine: 4).validationMessage == "Укажите количество: Лабрет — 8 мм.")
        #expect(
            draft.settingQuantity(10_001, forLine: 4).validationMessage
                == "Не больше 10\(Self.nbsp)000 шт в одной строке: Лабрет — 8 мм."
        )
        #expect(draft.settingUnitCost(DeliveryDraft.maxUnitCost + 1, forLine: 4).canSubmit == false)
        #expect(draft.settingUnitCost(0, forLine: 4).canSubmit, "a free unit is still a receipt")

        var long = draft
        long.supplier = String(repeating: "a", count: 101)
        #expect(long.validationMessage == "Поставщик — не длиннее 100 символов.")
        long.supplier = ""
        long.note = String(repeating: "a", count: 501)
        #expect(long.validationMessage == "Комментарий — не длиннее 500 символов.")
    }

    @Test("The request: trimmed supplier and note (none when blank), every line with its size and cost")
    func requestBody() throws {
        var draft = DeliveryDraft().adding(labret, variantId: 5, quantity: 4).adding(spray, variantId: 17)
        draft.supplier = "  Industrial Strength "
        draft.note = "   "
        let encoder = JSONCoding.makeEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let json = try #require(String(data: encoder.encode(draft.body), encoding: .utf8))
        #expect(json == #"{"lines":[{"productId":1,"quantity":4,"unitCost":700,"variantId":5},{"productId":7,"quantity":1,"variantId":17}],"supplier":"Industrial Strength"}"#)
    }

    // MARK: - Picker and suppliers

    @Test("The picker lists jewelry, goods, then consumables, the shown ones first; search covers sizes and suppliers")
    func catalogSearch() {
        let hidden = F.product(id: 3, name: "Банан", active: false, variants: [F.size(13, "", quantity: 0)])
        let options = DeliveryCatalog.options([needles, gloves, spray, hidden, labret])
        #expect(options.map(\.id) == [1, 3, 7, 9])
        #expect(DeliveryCatalog.filter(options, kind: nil, query: "10 мм").map(\.id) == [1])
        #expect(DeliveryCatalog.filter(options, kind: nil, query: "kwadron").map(\.id) == [9])
        #expect(DeliveryCatalog.filter(options, kind: .goods, query: "").map(\.id) == [7])
        #expect(DeliveryCatalog.filter(options, kind: nil, query: "  ").count == 4)
    }

    @Test("Suppliers: the latest ones, then those containing the typed text")
    func supplierSuggestions() {
        let suppliers = ["Industrial Strength", "Kwadron", "Анатометал", "Industrial Supply"].map {
            StockSupplier(name: $0, deliveries: 1, lastAt: nil)
        }
        #expect(DeliverySupplierSuggestions.matching(suppliers, typed: "").count == 4)
        #expect(DeliverySupplierSuggestions.matching(suppliers, typed: "indus") == ["Industrial Strength", "Industrial Supply"])
        #expect(DeliverySupplierSuggestions.matching(suppliers, typed: "kwadron").isEmpty, "already typed exactly")
    }

    // MARK: - Movements

    @Test("A delivery receipt reads «Поставка №4»; its note leaves the number out")
    func deliveryMovementText() {
        let movement = StockMovement(
            id: 81, productId: 1, productName: "Лабрет", variantId: 5, variantName: "8 мм", delta: 4, quantityAfter: 6,
            type: .receipt, note: "Поставка №4 · Накладная 17", saleId: nil, appointmentId: nil, deliveryId: 12,
            amount: 2_800, employee: nil, createdAt: Fixtures.referenceDate
        )
        #expect(MovementText.title(movement) == "Поставка №4 · +4 шт · 2\(Self.nbsp)800\(Self.nbsp)₽")
        #expect(MovementText.note(movement) == "Накладная 17")
        #expect(DeliveryText.movementNote("Поставка №4") == nil)
        #expect(DeliveryText.movementTitle(note: "Пришло") == "Поставка", "a note without the number")
        #expect(DeliveryText.number(inNote: "Поставка №123 · x") == 123)

        var plain = movement
        plain.deliveryId = nil
        #expect(MovementText.title(plain).hasPrefix("Приход · "))
        #expect(MovementText.note(plain) == "Поставка №4 · Накладная 17")
    }
}
