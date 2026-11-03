import Foundation

/// Texts of a sale refund. The prepayment part of a sale is never paid out by the refund: it is held for the
/// appointment again (staff refund it to the client or apply it to a new receipt later).
nonisolated enum SaleRefundText {
    /// «Вернуть 6 000 ₽» — the money handed back now; «Оформить возврат» when the prepayment, bonuses or certificates
    /// cover it all.
    static func confirmButton(_ payments: Payments) -> String {
        payments.paidNow > 0 ? "Вернуть \(Money.format(payments.paidNow))" : "Оформить возврат"
    }

    /// The consequences: what happens to the sale, the cash to hand back, where the prepayment goes.
    static func confirmationMessage(_ payments: Payments, isWhole: Bool = true) -> String {
        var parts = [
            isWhole
                ? "Продажа будет отмечена как возвращённая. Это действие нельзя отменить."
                : "Возврат по части чека нельзя отменить.",
        ]
        if payments.cash > 0 {
            parts.append("Выдайте клиенту \(Money.format(payments.cash)) наличными из кассы.")
        }
        if let note = depositNote(payments) {
            parts.append(note)
        }
        if payments.bonus > 0 {
            let verb = Plural.word(payments.bonus, one: "вернётся", few: "вернутся", many: "вернутся")
            parts.append("На счёт клиента \(verb) \(BonusText.count(payments.bonus)).")
        }
        if payments.certificate > 0 {
            parts.append("Оплата сертификатом (\(Money.format(payments.certificate))) вернётся на сертификат.")
        }
        return parts.joined(separator: " ")
    }

    /// A gift certificate sold in the sale is among the returned lines.
    static let certificateNote = "Проданный сертификат будет отменён. Если им уже частично оплатили покупку, возврат не пройдёт."

    static let qrNote = "Деньги по QR-коду приложение не возвращает: оформите возврат по СБП в интернет-банке Точки."

    /// «Предоплата 2 000 ₽ вернётся на запись — …»; `nil` when the refund returns no prepayment.
    static func depositNote(_ payments: Payments) -> String? {
        guard payments.deposit > 0 else { return nil }
        return "Предоплата \(Money.format(payments.deposit)) вернётся на запись — её можно будет вернуть клиенту или зачесть в новом чеке."
    }

    static let restockHint = "Выключите, если украшение использовано или повреждено."

    /// Footer of «Вернуть на склад»: stock goes back to the sizes that were sold
    /// («… в проданные размеры: Лабрет — 8 мм × 2. Выключите, …»).
    static func restockNote(_ items: [SaleItem]) -> String {
        restockNote(items.map { (item: $0, quantity: $0.quantity) })
    }

    /// The same for the units chosen to return.
    static func restockNote(_ lines: [(item: SaleItem, quantity: Int)]) -> String {
        let sized = lines.filter { $0.item.type == .product && $0.item.variantName.nonEmpty != nil }
        guard !sized.isEmpty else { return restockHint }
        let names = sized.map { line in
            let name = SizeLabel.fullName(name: line.item.name, size: line.item.variantName)
            return line.quantity > 1 ? "\(name) × \(line.quantity)" : name
        }
        return "Украшения вернутся на склад в проданные размеры: \(names.joined(separator: ", ")). \(restockHint)"
    }

    /// Under a sale line: «вернули 1 из 2», just «вернули» for the only unit; `nil` when nothing was returned.
    static func returnedUnits(_ returned: Int, of quantity: Int) -> String? {
        guard returned > 0 else { return nil }
        return returned >= quantity && quantity == 1 ? "вернули" : "вернули \(returned) из \(quantity)"
    }

    /// «Лабрет — 8 мм × 2», just the name for one unit.
    static func itemLine(_ item: SaleRefundItem) -> String {
        item.quantity > 1 ? "\(item.name) × \(item.quantity)" : item.name
    }

    /// «20 окт., 15:42 · Анна».
    static func refundSubtitle(_ refund: SaleRefund) -> String {
        [DateText.dateTime(refund.createdAt), refund.employee?.name].compactMap { $0 }.joined(separator: " · ")
    }

    /// Title of the confirmation dialog.
    static func confirmationTitle(isWhole: Bool) -> String {
        isWhole ? "Вернуть весь чек?" : "Вернуть выбранное?"
    }
}

/// The receipt in the client's Telegram.
nonisolated enum SaleReceiptText {
    /// «Чек отправлен в Telegram · 15:42» today, with the date on another day.
    static func sent(at date: Date, now: Date = .now) -> String {
        let when = Calendar.app.isDate(date, inSameDayAs: now) ? DateText.time(date) : DateText.dateTime(date)
        return "Чек отправлен в Telegram · \(when)"
    }
}
