import Foundation

/// One way the money of a refund goes back (docs/API.md «SaleRefund» `payments`, `bonusTakenBack`).
nonisolated struct RefundOutcomeLine: Hashable, Identifiable, Sendable {
    nonisolated enum Kind: Hashable, Sendable {
        case cash, transfer, card, qr, deposit, bonus, certificate
        /// Bonuses the sale earned that the refund takes back.
        case bonusTakenBack
    }

    let kind: Kind
    let amount: Int

    var id: Kind { kind }

    /// Before the refund — what happens and what staff do: «Наличными из кассы», «Переводом — верните клиенту сами»…
    var instruction: String {
        switch kind {
        case .cash: "Наличными из кассы"
        case .transfer: "Переводом — верните клиенту сами"
        case .card: "Картой — верните клиенту сами"
        case .qr: "По QR — верните в интернет-банке Точки"
        case .deposit: "Предоплата вернётся в запись"
        case .bonus: "Бонусы вернутся клиенту"
        case .certificate: "Сертификат пополнится"
        case .bonusTakenBack: "Спишем начисленные бонусы"
        }
    }

    /// A recorded refund: how it went back.
    var recordedTitle: String {
        switch kind {
        case .cash: "Наличными из кассы"
        case .transfer: "Переводом"
        case .card: "Картой"
        case .qr: "По QR"
        case .deposit: "В предоплату записи"
        case .bonus: "Бонусами"
        case .certificate: "На сертификат"
        case .bonusTakenBack: "Списали начисленные бонусы"
        }
    }

    /// «1 350 ₽»; bonuses read «+300» (back to the client) and «−67» (taken back).
    var value: String {
        switch kind {
        case .bonus: "+" + Money.group(UInt(max(0, amount)))
        case .bonusTakenBack: Money.minus + Money.group(UInt(max(0, amount)))
        default: Money.format(amount)
        }
    }

    var symbol: String {
        switch kind {
        case .cash: "banknote"
        case .transfer: "arrow.left.arrow.right"
        case .card: "creditcard"
        case .qr: "qrcode"
        case .deposit: "rublesign.circle"
        case .bonus: "star.circle"
        case .certificate: "gift"
        case .bonusTakenBack: "star.slash"
        }
    }

    /// Money staff hand back themselves (cash, transfer, card, QR), not credits the server restores.
    var isPaidOut: Bool { [.cash, .transfer, .card, .qr].contains(kind) }
}

nonisolated enum RefundOutcome {
    /// The non-zero parts in the order the sheet reads them: money first, then the prepayment, bonuses and
    /// certificates, and the earned bonuses taken back last.
    static func lines(payments: Payments, bonusTakenBack: Int) -> [RefundOutcomeLine] {
        let parts: [(RefundOutcomeLine.Kind, Int)] = [
            (.cash, payments.cash),
            (.transfer, payments.transfer),
            (.card, payments.card),
            (.qr, payments.qr),
            (.deposit, payments.deposit),
            (.bonus, payments.bonus),
            (.certificate, payments.certificate),
            (.bonusTakenBack, bonusTakenBack),
        ]
        return parts.filter { $0.1 > 0 }.map { RefundOutcomeLine(kind: $0.0, amount: $0.1) }
    }

    static func lines(_ preview: RefundPreview) -> [RefundOutcomeLine] {
        lines(payments: preview.payments, bonusTakenBack: preview.bonusTakenBack)
    }

    static func lines(_ refund: SaleRefund) -> [RefundOutcomeLine] {
        lines(payments: refund.payments, bonusTakenBack: refund.bonusTakenBack)
    }
}
