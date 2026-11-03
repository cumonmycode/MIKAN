import SwiftUI

nonisolated extension MovementType {
    var title: String {
        switch self {
        case .receipt: "Приход"
        case .sale: "Продажа"
        case .returned: "Возврат"
        case .writeoff: "Списание"
        case .usage: "Расход"
        case .adjustment: "Инвентаризация"
        case .purchase: "Покупка"
        case .other: "Движение"
        }
    }

    /// Short label for segmented pickers.
    var shortTitle: String {
        switch self {
        case .adjustment: "Пересчёт"
        default: title
        }
    }

    var symbol: String {
        switch self {
        case .receipt: "arrow.down.to.line"
        case .sale: "cart"
        case .returned: "arrow.uturn.backward"
        case .writeoff: "trash"
        case .usage: "drop"
        case .adjustment: "list.number"
        case .purchase: "cart.badge.plus"
        case .other: "arrow.left.arrow.right"
        }
    }

    var hint: String {
        switch self {
        case .receipt: "Сколько единиц поступило на склад."
        case .writeoff: "Брак, потеря, истёк срок — сколько единиц списать."
        case .usage: "Сколько ушло на процедуры (не через завершение записи)."
        case .adjustment: "Пересчитайте остаток и введите фактическое количество."
        case .sale, .returned, .purchase, .other: ""
        }
    }
}

/// Texts of a stock movement row.
nonisolated enum MovementText {
    /// «Покупка · 3 500 ₽», «Приход · +5 шт · 6 000 ₽» for a receipt recorded with its cost, the operation's name
    /// otherwise. A receipt of a delivery reads «Поставка №4».
    static func title(_ movement: StockMovement, unit: String = ProductLimits.defaultUnit) -> String {
        let name = operation(movement)
        guard let amount = movement.amount else { return name }
        switch movement.type {
        case .purchase:
            return "\(name) · \(Money.format(amount))"
        case .receipt:
            let quantity = InventoryText.quantity(movement.delta, unit: unit)
            return "\(name) · +\(quantity) · \(Money.format(amount))"
        default:
            return name
        }
    }

    /// «Приход», «Поставка №4»…
    static func operation(_ movement: StockMovement) -> String {
        isDelivery(movement) ? DeliveryText.movementTitle(note: movement.note) : movement.type.title
    }

    /// The note under the row; a delivery receipt leaves out «Поставка №4» that its title already says.
    static func note(_ movement: StockMovement) -> String? {
        isDelivery(movement) ? DeliveryText.movementNote(movement.note) : movement.note.nonEmpty
    }

    static func isDelivery(_ movement: StockMovement) -> Bool {
        movement.type == .receipt && movement.deliveryId != nil
    }

    /// «15 окт., 14:00 · Анна»; the list of all products starts with the operation: «Покупка · 3 500 ₽ · …».
    static func subtitle(_ movement: StockMovement, showsProduct: Bool, unit: String = ProductLimits.defaultUnit) -> String {
        var parts: [String] = []
        if showsProduct { parts.append(title(movement, unit: unit)) }
        parts.append(DateText.dateTime(movement.createdAt))
        if let employee = movement.employee { parts.append(employee.name) }
        return parts.joined(separator: " · ")
    }
}

/// Stock movement row: type, signed delta, resulting stock of the size, author and note; a purchase shows what it cost
/// instead of the stock. The global list names the product and size («Лабрет — 8 мм»); a product's own list shows the
/// size as a badge.
struct MovementRow: View {
    let movement: StockMovement
    var showsProduct = false
    /// The product's unit, for a receipt with its cost («+5 шт»).
    var unit = ProductLimits.defaultUnit
    /// A chevron: the row opens something (its delivery) outside a list, which draws none itself.
    var showsDisclosure = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: movement.type.symbol)
                .font(.body)
                .foregroundStyle(movement.delta >= 0 ? Color.green : Color.orange)
                .frame(width: 28, height: 28)
                .background((movement.delta >= 0 ? Color.green : Color.orange).opacity(0.14), in: .circle)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(showsProduct ? movement.displayName : MovementText.title(movement, unit: unit))
                        .font(.subheadline.weight(.semibold))
                    if !showsProduct, let size = movement.variantName.nonEmpty {
                        StatusBadge(text: size, color: .secondary)
                    }
                }
                Text(MovementText.subtitle(movement, showsProduct: showsProduct, unit: unit))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let note = MovementText.note(movement) {
                    Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            if movement.movesStock {
                stockChange
            }
            if showsDisclosure {
                Image(systemName: "chevron.forward")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .frame(maxHeight: .infinity)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var stockChange: some View {
        VStack(alignment: .trailing, spacing: 3) {
            Text(movement.delta > 0 ? "+\(movement.delta)" : "\(movement.delta)")
                .font(.headline)
                .monospacedDigit()
                .foregroundStyle(movement.delta >= 0 ? Color.green : Color.primary)
            Text("→ \(movement.quantityAfter)")
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
    }
}
