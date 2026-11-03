import Foundation

/// Texts of gift certificates: statuses, validity, why one can't pay, the operations list.
nonisolated enum CertificateText {
    static func statusTitle(_ status: GiftCertificateStatus) -> String {
        switch status {
        case .active: "Действует"
        case .used: "Использован"
        case .expired: "Истёк"
        case .cancelled: "Отменён"
        case .unknown: "Неизвестно"
        }
    }

    /// Status filter chips; `nil` — all.
    static func filterTitle(_ status: GiftCertificateStatus?) -> String {
        switch status {
        case nil: "Все"
        case .active: "Действуют"
        case .used: "Использованы"
        case .expired: "Истекли"
        case .cancelled: "Отменены"
        case .unknown: "Другие"
        }
    }

    /// «до 19 октября 2027» / «бессрочно»
    static func validity(_ expiresAt: Date?) -> String {
        guard let expiresAt else { return "бессрочно" }
        return "до \(DateText.fullDate(expiresAt))"
    }

    /// Why the certificate can't pay now; `nil` when it can.
    static func unavailableReason(_ certificate: GiftCertificate, now: Date = .now) -> String? {
        switch certificate.status {
        case .used: return "Сертификат уже использован полностью"
        case .expired: return "Срок действия сертификата истёк"
        case .cancelled: return "Сертификат отменён"
        case .unknown: return "Сертификат сейчас не действует"
        case .active: break
        }
        if certificate.balance <= 0 { return "На сертификате не осталось денег" }
        if let expiresAt = certificate.expiresAt, expiresAt <= now { return "Срок действия сертификата истёк" }
        return nil
    }

    /// «Остаток 3 000 из 5 000 ₽»
    static func balance(_ certificate: GiftCertificate) -> String {
        guard certificate.balance != certificate.amount else { return Money.format(certificate.amount) }
        return "Остаток \(Money.group(UInt(max(0, certificate.balance)))) из \(Money.format(certificate.amount))"
    }

    static func operationTitle(_ type: GiftCertificateOperationType) -> String {
        switch type {
        case .issue: "Продан"
        case .redeem: "Оплата покупки"
        case .refund: "Возврат покупки"
        case .cancel: "Аннулирован"
        case .expire: "Срок истёк"
        case .unknown: "Операция"
        }
    }

    /// Amounts come signed (credits > 0, debits < 0); a debit type sent unsigned still reads as a debit.
    static func signedAmount(type: GiftCertificateOperationType, amount: Int) -> Int {
        guard amount > 0 else { return amount }
        switch type {
        case .redeem, .cancel, .expire: return -amount
        case .issue, .refund, .unknown: return amount
        }
    }
}

/// Texts of a client's bonus ledger.
nonisolated enum BonusLedger {
    static func title(_ type: BonusOperationType) -> String {
        switch type {
        case .earn: "Начислено за покупку"
        case .spend: "Оплата бонусами"
        case .gift: "Подарок"
        case .expire: "Сгорели"
        case .adjust: "Изменено вручную"
        case .reverse: "Возврат покупки"
        case .unknown: "Операция"
        }
    }

    static func symbol(_ type: BonusOperationType) -> String {
        switch type {
        case .earn: "plus.circle"
        case .spend: "cart"
        case .gift: "gift"
        case .expire: "flame"
        case .adjust: "pencil.circle"
        case .reverse: "arrow.uturn.backward.circle"
        case .unknown: "circle"
        }
    }

    /// Credits positive, debits negative: spending and burning are debits whatever sign the server sent.
    static func signedAmount(_ operation: BonusOperation) -> Int {
        guard operation.amount > 0 else { return operation.amount }
        switch operation.type {
        case .spend, .expire: return -operation.amount
        default: return operation.amount
        }
    }

    /// «+500» / «−200» bonuses, no currency (1 bonus = 1 ₽ but they are not money).
    static func signedText(_ amount: Int) -> String {
        let digits = Money.group(amount.magnitude)
        if amount > 0 { return "+" + digits }
        return amount < 0 ? Money.minus + digits : digits
    }

    /// A manual adjustment: a non-zero amount and a note; taking never exceeds the balance.
    static func isValidAdjustment(amount: Int, note: String, balance: Int) -> Bool {
        guard amount != 0, note.nonEmpty != nil else { return false }
        return amount > 0 || -amount <= max(0, balance)
    }
}
