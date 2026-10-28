import Foundation

/// One card of «К оплате» on the POS hub: an open receipt (a visit in progress or a sale without a visit) or one of
/// today's unpaid visits that has not started yet. A tap opens its receipt.
nonisolated enum PaymentDue: Hashable, Identifiable, Sendable {
    case receipt(OpenReceipt)
    case visit(Appointment)

    var id: String {
        switch self {
        case .receipt(let receipt): "receipt-\(receipt.id)"
        case .visit(let appointment): "visit-\(appointment.id)"
        }
    }

    /// The visit it pays for; `nil` for a receipt without one.
    var appointment: Appointment? {
        switch self {
        case .receipt(let receipt): receipt.appointment
        case .visit(let appointment): appointment
        }
    }

    var receipt: OpenReceipt? {
        if case .receipt(let receipt) = self { return receipt }
        return nil
    }

    /// Its place in the list: the visit's start, else when the receipt was opened.
    var time: Date {
        switch self {
        case .receipt(let receipt): receipt.appointment?.startsAt ?? receipt.createdAt
        case .visit(let appointment): appointment.startsAt
        }
    }

    /// What it comes to: the receipt total, or the visit's price before it is started.
    var amount: Int {
        switch self {
        case .receipt(let receipt): receipt.total
        case .visit(let appointment): appointment.price
        }
    }

    var clientName: String {
        switch self {
        case .receipt(let receipt): (receipt.client ?? receipt.appointment?.client)?.fullName ?? "Без клиента"
        case .visit(let appointment): appointment.client.fullName
        }
    }
}

/// «Мои / Все» on the hub of a master.
nonisolated enum PaymentDueScope: String, CaseIterable, Identifiable, Sendable {
    case mine
    case all

    var id: String { rawValue }

    var title: String {
        switch self {
        case .mine: "Мои"
        case .all: "Все"
        }
    }
}

nonisolated enum PaymentDueList {
    /// Open receipts and the visits not started yet (no receipt of their own), earliest first; at the same time
    /// a receipt goes before a visit.
    static func items(receipts: [OpenReceipt], visits: [Appointment]) -> [PaymentDue] {
        let waiting = PaymentQueue.notStarted(visits, openReceipts: receipts)
        let all = receipts.map(PaymentDue.receipt) + waiting.map(PaymentDue.visit)
        return all.sorted { lhs, rhs in
            if lhs.time != rhs.time { return lhs.time < rhs.time }
            if (lhs.receipt != nil) != (rhs.receipt != nil) { return lhs.receipt != nil }
            return lhs.id < rhs.id
        }
    }

    /// The employee's own: their visits, and receipts without a visit that they opened.
    static func isMine(_ item: PaymentDue, employeeId: Int) -> Bool {
        if let appointment = item.appointment { return appointment.master.id == employeeId }
        return item.receipt?.openedBy?.id == employeeId
    }

    static func filtered(_ items: [PaymentDue], scope: PaymentDueScope, employeeId: Int?) -> [PaymentDue] {
        guard scope == .mine, let employeeId else { return items }
        return items.filter { isMine($0, employeeId: employeeId) }
    }

    /// The filter is offered to a master only.
    static func offersScope(to employee: Employee?) -> Bool {
        employee?.isMaster == true
    }

    /// A master starts on «Мои» while they have something there, otherwise on «Все».
    static func defaultScope(_ items: [PaymentDue], employee: Employee?) -> PaymentDueScope {
        guard let employee, offersScope(to: employee) else { return .all }
        return items.contains { isMine($0, employeeId: employee.id) } ? .mine : .all
    }
}

/// Texts of a «К оплате» card.
nonisolated enum PaymentDueText {
    /// How many line names a card lists before «и ещё N».
    static let namedLines = 2

    /// The visit's services, or the receipt's lines: «Лабрет — 8 мм, Хеликс и ещё 2»; «Пусто» without lines.
    static func contents(_ item: PaymentDue) -> String {
        switch item {
        case .visit(let appointment):
            return appointment.displayTitle
        case .receipt(let receipt):
            guard !receipt.items.isEmpty else { return receipt.appointment?.displayTitle ?? "Пусто" }
            return names(receipt.items.map(\.name))
        }
    }

    static func names(_ names: [String]) -> String {
        let shown = names.prefix(namedLines).joined(separator: ", ")
        let rest = names.count - namedLines
        return rest > 0 ? "\(shown) и ещё \(rest)" : shown
    }

    /// «14:00–15:00 · Фатима» for a visit; «Без записи · открыл(а) Анна · 14:05» for a receipt without one.
    static func when(_ item: PaymentDue, now: Date = .now, calendar: Calendar = .app) -> String {
        if let appointment = item.appointment {
            return "\(DateText.timeRange(appointment.startsAt, appointment.endsAt)) · \(appointment.master.name)"
        }
        guard let receipt = item.receipt else { return "" }
        return "Без записи · \(OpenReceiptText.opened(receipt, now: now, calendar: calendar).lowercasedFirst)"
    }
}

private extension String {
    /// «Открыл(а) Анна» → «открыл(а) Анна».
    nonisolated var lowercasedFirst: String {
        guard let first else { return self }
        return first.lowercased() + dropFirst()
    }
}
