import Foundation

/// Texts of the open receipts on the POS hub (who opened one and when) and of deleting one.
nonisolated enum OpenReceiptText {
    static let deleteTitle = "Удалить чек?"

    /// "Открыл(а) Фатима · 14:05"; a receipt left from another day adds the date: "… · 15 окт., 14:05".
    static func opened(_ receipt: OpenReceipt, now: Date = .now, calendar: Calendar = .app) -> String {
        let when = calendar.isDate(receipt.createdAt, inSameDayAs: now)
            ? DateText.time(receipt.createdAt)
            : DateText.dateTime(receipt.createdAt)
        guard let employee = receipt.openedBy else { return "Открыт · \(when)" }
        return "Открыл(а) \(employee.name) · \(when)"
    }

    /// What deleting changes: only the lines go; the stock and a held prepayment stay, the visit waits for payment.
    static func deleteMessage(subtotal: Int, itemCount: Int, hasAppointment: Bool) -> String {
        switch (itemCount > 0, hasAppointment) {
        case (true, true):
            "Позиции на \(Money.format(subtotal)) будут удалены. Склад и предоплата не изменятся, запись вернётся в «К оплате»."
        case (true, false):
            "Позиции на \(Money.format(subtotal)) будут удалены. Склад не изменится."
        case (false, true):
            "Чек пустой. Предоплата не изменится, запись вернётся в «К оплате»."
        case (false, false):
            "Чек пустой."
        }
    }
}

/// The receipt waiting for «Удалить чек?», with what the confirmation says about it.
nonisolated struct ReceiptDeletion: Identifiable, Equatable, Sendable {
    let id: Int
    let subtotal: Int
    let itemCount: Int
    let hasAppointment: Bool

    init(id: Int, subtotal: Int, itemCount: Int, hasAppointment: Bool) {
        self.id = id
        self.subtotal = subtotal
        self.itemCount = itemCount
        self.hasAppointment = hasAppointment
    }

    init(_ receipt: OpenReceipt) {
        self.init(
            id: receipt.id, subtotal: receipt.subtotal, itemCount: receipt.itemCount,
            hasAppointment: receipt.appointment != nil
        )
    }

    var message: String {
        OpenReceiptText.deleteMessage(subtotal: subtotal, itemCount: itemCount, hasAppointment: hasAppointment)
    }
}
