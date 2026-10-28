import SwiftUI

// Pure online-booking logic shared by the calendar, the list «Онлайн-записи» and the appointment card.

/// How an unsettled online booking is marked: a dashed outline in the calendar and a line in cards.
enum OnlineMark: Equatable {
    case awaitingConfirmation
    /// `until` — the end of the payment hold.
    case awaitingPayment(until: Date?)

    /// `nil` once settled, for staff bookings and for cancelled or finished visits.
    static func of(_ appointment: Appointment) -> OnlineMark? {
        guard appointment.isUnsettledOnline, let state = appointment.onlineState else { return nil }
        switch state {
        case .awaitingConfirmation: return .awaitingConfirmation
        case .awaitingPayment: return .awaitingPayment(until: appointment.holdUntil)
        }
    }

    /// «Ждёт подтверждения», «Ждёт оплату до 14:35».
    var text: String {
        switch self {
        case .awaitingConfirmation: "Ждёт подтверждения"
        case .awaitingPayment(let until): until.map { "Ждёт оплату до \(DateText.time($0))" } ?? "Ждёт оплату"
        }
    }

    var symbol: String {
        switch self {
        case .awaitingConfirmation: "clock.badge.questionmark"
        case .awaitingPayment: DepositStyle.waitingSymbol
        }
    }

    var color: Color { .orange }
}

extension AppointmentChannel {
    /// «сайт», «Mini App», «бот»; `nil` for a staff booking.
    var onlineTitle: String? {
        switch self {
        case .app: nil
        case .web: "сайт"
        case .miniapp: "Mini App"
        case .bot: "бот"
        case .other: "другой канал"
        }
    }

    /// «Записался онлайн: сайт»; `nil` for a staff booking.
    var bookedText: String? {
        onlineTitle.map { "Записался онлайн: \($0)" }
    }

    var symbol: String {
        switch self {
        case .app: "person.crop.circle"
        case .web, .other: "globe"
        case .miniapp: "apps.iphone"
        case .bot: "paperplane"
        }
    }
}

/// What staff can do with an unsettled online booking.
enum OnlineBookingAction: Hashable, CaseIterable {
    /// `…/online/confirm`: only while it waits for staff.
    case confirm
    /// `…/online/reject`: while it waits for staff or for the payment.
    case reject

    /// Owner and admin act on any booking, a master on their own only.
    static func available(for appointment: Appointment, permissions: Permissions) -> [OnlineBookingAction] {
        guard appointment.isUnsettledOnline, permissions.canChange(appointment) else { return [] }
        return appointment.onlineState == .awaitingConfirmation ? [.confirm, .reject] : [.reject]
    }
}

/// The list «Онлайн-записи»: waiting for confirmation first, then waiting for payment, each by start.
enum OnlineBookingQueue {
    /// Its section order.
    static let states: [OnlineBookingState] = [.awaitingConfirmation, .awaitingPayment]

    /// Unsettled bookings in `state`, earliest first (one id once).
    static func items(_ appointments: [Appointment], in state: OnlineBookingState) -> [Appointment] {
        var seen = Set<Int>()
        return appointments
            .filter { $0.isUnsettledOnline && $0.onlineState == state && seen.insert($0.id).inserted }
            .sorted { ($0.startsAt, $0.id) < ($1.startsAt, $1.id) }
    }

    /// The whole list in display order.
    static func ordered(_ appointments: [Appointment]) -> [Appointment] {
        states.flatMap { items(appointments, in: $0) }
    }

    /// After a confirmation, a rejection or a refresh of one booking: it stays only while still unsettled.
    static func applying(_ updated: Appointment, to appointments: [Appointment]) -> [Appointment] {
        ordered(appointments.map { $0.id == updated.id ? updated : $0 })
    }

    /// «Ждут подтверждения», «Ждут оплату».
    static func title(_ state: OnlineBookingState) -> String {
        switch state {
        case .awaitingConfirmation: "Ждут подтверждения"
        case .awaitingPayment: "Ждут оплату"
        }
    }
}

/// The client booking page of the current server: `PUBLIC_URL/book` (the server's origin).
nonisolated enum BookingLink {
    static func url(server: URL) -> URL {
        server.appending(path: "book")
    }
}
