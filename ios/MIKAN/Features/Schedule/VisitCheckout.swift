import Foundation

/// The POS action of an appointment card while it is unpaid: continue its open receipt, start the visit (its receipt
/// opens over the card), or take payment for a completed visit.
nonisolated enum VisitCheckout: Equatable, Sendable {
    /// The visit has started: its receipt is open in the POS.
    case openReceipt
    /// Scheduled or confirmed, today or earlier, no receipt yet.
    case startVisit
    /// Completed without a receipt: «Принять оплату · N ₽».
    case takePayment(Int)

    /// `nil` when paid, cancelled, no-show, or a future visit not started yet.
    static func of(_ appointment: Appointment, now: Date = .now, calendar: Calendar = .app) -> VisitCheckout? {
        guard !appointment.isPaid else { return nil }
        if appointment.receiptId != nil { return .openReceipt }
        switch appointment.status {
        case .completed:
            return .takePayment(appointment.price)
        case .scheduled, .confirmed:
            let today = PaymentQueue.day(containing: now, calendar: calendar)
            return appointment.startsAt < today.end ? .startVisit : nil
        case .cancelled, .noShow:
            return nil
        }
    }

    var title: String {
        switch self {
        case .openReceipt: "Открыть чек"
        case .startVisit: "Начать визит"
        case .takePayment(let amount): "Принять оплату · \(Money.format(amount))"
        }
    }

    var systemImage: String {
        switch self {
        case .openReceipt: "cart.fill"
        case .startVisit: "play.fill"
        case .takePayment: "creditcard.fill"
        }
    }

    var footer: String {
        switch self {
        case .openReceipt:
            "Визит идёт — чек открыт. В нём можно добавить украшения и принять оплату."
        case .startVisit:
            "Откроется чек с услугами, клиентом и предоплатой: добавьте украшения и примите оплату здесь же."
        case .takePayment:
            "Откроется чек с услугами, клиентом и предоплатой."
        }
    }
}
