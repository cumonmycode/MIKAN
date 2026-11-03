import Foundation

// Pure logic of the studio's cancellation rules on the appointment card (`Appointment.cancellation`).

enum DepositRules {
    /// A cancellation at `date` is late: after the free-cancellation moment, or always when there is none.
    static func isLate(_ rules: AppointmentCancellation, at date: Date) -> Bool {
        guard let freeUntil = rules.freeUntil else { return true }
        return date > freeUntil
    }

    /// Cancelling at `date` is free by the rules (an older server has none: never).
    static func isFreeCancellation(_ appointment: Appointment, at date: Date) -> Bool {
        appointment.cancellation.map { !isLate($0, at: date) } ?? false
    }

    /// «Бесплатная отмена до 14 окт., 12:00» / «…уже недоступна» / «…не предусмотрена» for an open appointment.
    static func freeUntilLine(_ appointment: Appointment, now: Date = .now) -> String? {
        guard appointment.isOpen, let rules = appointment.cancellation else { return nil }
        guard let freeUntil = rules.freeUntil else { return "Бесплатная отмена не предусмотрена" }
        return now <= freeUntil ? "Бесплатная отмена до \(DateText.dateTime(freeUntil))" : "Бесплатная отмена уже недоступна"
    }

    /// What the rules keep of the held prepayment if the appointment becomes `status` at `date`:
    /// 0 for a free cancellation, `nil` without rules (an older server) or with nothing held.
    static func retain(_ appointment: Appointment, becoming status: AppointmentStatus, at date: Date) -> Int? {
        guard appointment.deposit > 0, let rules = appointment.cancellation else { return nil }
        switch status {
        case .noShow:
            return min(appointment.deposit, rules.noShowRetain)
        case .cancelled:
            return isLate(rules, at: date) ? min(appointment.deposit, rules.lateRetain) : 0
        case .scheduled, .confirmed, .completed:
            return nil
        }
    }

    /// The line of the cancel / no-show confirmation: «По правилам студии удерживается 2 000 ₽ из 2 000 ₽.»
    static func closingNote(_ appointment: Appointment, becoming status: AppointmentStatus, at date: Date = .now) -> String? {
        guard let kept = retain(appointment, becoming: status, at: date) else { return nil }
        return note(kept: kept, held: appointment.deposit, free: status == .cancelled && isFreeCancellation(appointment, at: date))
    }

    /// «По правилам студии удерживается 1 000 ₽ из 2 000 ₽, остальное возвращается клиенту.»
    static func note(kept: Int, held: Int, free: Bool) -> String {
        if kept >= held { return "По правилам студии удерживается \(Money.format(kept)) из \(Money.format(held))." }
        if kept > 0 {
            return "По правилам студии удерживается \(Money.format(kept)) из \(Money.format(held)), остальное возвращается клиенту."
        }
        return free
            ? "Отмена бесплатная — предоплату \(Money.format(held)) можно вернуть клиенту."
            : "По правилам студии предоплата \(Money.format(held)) возвращается клиенту."
    }

    /// The amount the retain sheet opens with from the card's «Удержать»: the rules' share of what is held (a
    /// cancellation counts as late — that is why staff keep money), else everything. After an earlier retain the
    /// rules no longer apply to the remainder, so it is the remainder.
    static func retainPrefill(_ appointment: Appointment) -> Int {
        let held = appointment.deposit
        let retainedBefore = appointment.depositOperations.contains { $0.type == .retain }
        guard !retainedBefore, let rules = appointment.cancellation else { return held }
        let share = appointment.status == .noShow ? rules.noShowRetain : rules.lateRetain
        return share > 0 ? min(held, share) : held
    }

    /// Note of a retain: «Поздняя отмена — меньше 24 ч до записи» (as the server words it), «Неявка», «Отмена записи».
    static func retainReason(_ appointment: Appointment) -> String {
        guard appointment.status == .cancelled, let rules = appointment.cancellation else {
            return DepositText.retainReason(for: appointment.status)
        }
        guard let freeUntil = rules.freeUntil else { return "Отмена записи — по правилам студии" }
        let hours = Int((appointment.startsAt.timeIntervalSince(freeUntil) / 3600).rounded())
        return "Поздняя отмена — меньше \(hours) ч до записи"
    }
}

/// The refund-or-retain question right after a cancellation / no-show of an appointment holding a prepayment.
struct DepositDecision: Equatable {
    /// Still held (after anything the server retained by itself).
    let held: Int
    /// Retained by the server just now (`autoRetain` is on): only the remainder is left to refund.
    let autoRetained: Int
    /// What the rules keep of `held` (0 — a free cancellation); `nil` without rules.
    let rulesRetain: Int?
    /// The cancellation was free by the rules.
    let isFree: Bool

    init(before: Appointment, after: Appointment, at date: Date) {
        let known = Set(before.depositOperations.map(\.id))
        held = after.deposit
        autoRetained = after.depositOperations
            .filter { $0.type == .retain && !known.contains($0.id) }
            .reduce(0) { $0 + $1.amount }
        // Counted on the appointment as it was: after a retain the server recounts the rules on the remainder.
        rulesRetain = autoRetained > 0 ? 0 : DepositRules.retain(before, becoming: after.status, at: date)
        isFree = after.status == .cancelled && DepositRules.isFreeCancellation(before, at: date)
    }

    /// What the retain sheet opens with: the rules' share, or everything held when they keep nothing.
    var retainPrefill: Int {
        guard let rulesRetain, rulesRetain > 0 else { return held }
        return min(held, rulesRetain)
    }

    /// The rules call for keeping money, so «Удержать» goes first.
    var suggestsRetain: Bool { (rulesRetain ?? 0) > 0 }

    /// Without a decision (should not happen): the question as older builds asked it.
    static let fallbackMessage = "Клиент внёс предоплату. Вернуть её или оставить студии? Решить можно и позже в карточке записи."

    var message: String {
        if autoRetained > 0 {
            return "По правилам студии удержано \(Money.format(autoRetained)). Остаток \(Money.format(held)) можно вернуть клиенту — сейчас или позже в карточке записи."
        }
        guard let rulesRetain else { return Self.fallbackMessage }
        return DepositRules.note(kept: rulesRetain, held: held, free: isFree) + " Решить можно и позже в карточке записи."
    }
}
