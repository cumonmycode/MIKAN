import Foundation

/// Whose prices catalog services take in a receipt — the server's rule for receipt lines (docs/API.md «Open
/// receipts», «Service» `masterPrices`).
nonisolated enum ReceiptPricing {
    /// The master of the receipt's visit; without a visit the employee who opened the receipt when they are a master
    /// (`masterIds`); `nil` — the catalog price.
    static func masterId(appointmentMasterId: Int?, openedBy: Int?, masterIds: Set<Int>) -> Int? {
        if let appointmentMasterId { return appointmentMasterId }
        guard let openedBy, masterIds.contains(openedBy) else { return nil }
        return openedBy
    }

    /// Who is a master: the staff list (inactive masters too), and the signed-in employee before it loads.
    static func masterIds(employees: [Employee], signedIn: Employee?) -> Set<Int> {
        let staff = employees.filter(\.isMaster).map(\.id)
        let me = signedIn.flatMap { $0.isMaster ? $0.id : nil }
        return Set(staff + [me].compactMap { $0 })
    }
}

/// What the big button under the receipt does.
nonisolated enum ReceiptSubmitAction: Equatable, Sendable {
    /// No cash shift is open: selling needs one (`409` from the server otherwise).
    case openShift
    /// Sell now; `amount` is what the client pays by the payment methods.
    case sell(amount: Int)
    /// Show the SBP QR code for the QR share first.
    case showQr(amount: Int)

    /// `shiftIsOpen` is `nil` while the shift is not loaded: the server then decides.
    static func of(shiftIsOpen: Bool?, qrShare: Int, amountDue: Int) -> ReceiptSubmitAction {
        if shiftIsOpen == false { return .openShift }
        return qrShare > 0 ? .showQr(amount: qrShare) : .sell(amount: amountDue)
    }

    /// «Провести · 3 500 ₽», «Провести продажу» when nothing is due, «Показать QR-код · 3 500 ₽», «Открыть смену».
    var title: String {
        switch self {
        case .openShift: "Открыть смену"
        case .sell(let amount): amount > 0 ? "Провести · \(Money.format(amount))" : "Провести продажу"
        case .showQr(let amount): "Показать QR-код · \(Money.format(amount))"
        }
    }

    var systemImage: String? {
        switch self {
        case .openShift: "lock.open.fill"
        case .sell: nil
        case .showQr: "qrcode"
        }
    }
}

/// The receipt in the client's Telegram after a sale (docs/API.md «Receipt in Telegram»): the server sends it by itself
/// right after the sale; the success screen checks a few times and otherwise offers to send it by hand.
nonisolated enum SaleReceiptDelivery {
    static let checkInterval: Duration = .seconds(2)
    static let maxChecks = 3

    /// The initial state of the success screen. The bot sends the receipt by itself only to a client with Telegram
    /// linked, while the studio has it on (`sendsReceipts` `nil` — unknown, the server default is on); a client
    /// without Telegram cannot get it at all.
    static func initialState(_ sale: Sale, sendsReceipts: Bool?) -> SaleReceiptDeliveryState {
        if let sentAt = sale.receiptSentAt { return .sent(sentAt) }
        guard let client = sale.client else { return .noClient }
        guard client.telegramLinked else { return .noTelegram }
        return sendsReceipts == false ? .notSent : .waiting
    }

    /// After a check of the sale: sent, still waiting (checks left), or not sent.
    static func state(after sale: Sale, checksDone: Int) -> SaleReceiptDeliveryState {
        if let sentAt = sale.receiptSentAt { return .sent(sentAt) }
        return checksDone < maxChecks ? .waiting : .notSent
    }
}

/// What the success screen says about the receipt in Telegram.
nonisolated enum SaleReceiptDeliveryState: Equatable, Sendable {
    /// The sale has no client: there is nobody to send it to.
    case noClient
    /// The client has not linked Telegram: «У клиента не подключён Telegram».
    case noTelegram
    /// Waiting for the bot to send it.
    case waiting
    case sent(Date)
    /// Not sent: «Отправить чек в Telegram».
    case notSent
    /// Being sent by hand.
    case sending
}
