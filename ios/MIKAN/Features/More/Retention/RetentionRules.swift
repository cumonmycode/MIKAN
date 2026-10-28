import Foundation

/// The limits `PUT /settings/retention` enforces (server `routes/retention-settings.ts`), checked before saving so the
/// form says what to fix next to the field. Every group is checked whether it is on or off: the app sends all of them.
nonisolated enum RetentionRules {
    static let cashbackPercent = 0...50
    static let maxPaymentPercent = 0...100
    static let expiryDays = 1...3650
    static let bonusAmount = 0...100_000
    static let bonusDays = 1...365
    static let discountPercent = 0...100
    static let discountWindowDays = 0...31
    static let afterMonths = 1...24
    static let dailyLimit = 1...500
    static let validityMonths = 1...60
    /// Greeting texts, trimmed. Counted like the server: JavaScript string length (UTF-16 code units).
    static let textLength = 1...1000

    /// Defaults for a value switched back on («сгорают», «срок действия»).
    static let defaultExpiryDays = 365
    static let defaultValidityMonths = 12

    /// The first problem of the whole form, or `nil` when it can be saved.
    static func issue(_ settings: RetentionSettings) -> String? {
        loyaltyIssue(settings.loyalty)
            ?? birthdayIssue(settings.birthday)
            ?? winbackIssue(settings.winback)
            ?? certificatesIssue(settings.certificates)
    }

    static func loyaltyIssue(_ loyalty: LoyaltySettings) -> String? {
        if !cashbackPercent.contains(loyalty.cashbackPercent) {
            return "Кешбэк — от \(cashbackPercent.lowerBound) до \(cashbackPercent.upperBound)%."
        }
        if !maxPaymentPercent.contains(loyalty.maxPaymentPercent) {
            return "Оплата бонусами — от \(maxPaymentPercent.lowerBound) до \(maxPaymentPercent.upperBound)% чека."
        }
        if let days = loyalty.expiryDays, !expiryDays.contains(days) {
            return "Срок жизни бонусов — от 1 до \(group(expiryDays.upperBound)) дней."
        }
        return nil
    }

    static func birthdayIssue(_ birthday: BirthdaySettings) -> String? {
        if let issue = timeIssue(birthday.sendAt) { return issue }
        if let issue = textIssue(birthday.text, what: "Текст поздравления") { return issue }
        if let issue = giftIssue(amount: birthday.bonusAmount, days: birthday.bonusDays) { return issue }
        if !discountPercent.contains(birthday.discountPercent) {
            return "Скидка — от 0 до 100%."
        }
        if !discountWindowDays.contains(birthday.discountDaysBefore) || !discountWindowDays.contains(birthday.discountDaysAfter) {
            return "Скидка действует не дольше \(discountWindowDays.upperBound) дней до и после дня рождения."
        }
        return nil
    }

    static func winbackIssue(_ winback: WinbackSettings) -> String? {
        if !afterMonths.contains(winback.afterMonths) {
            return "Напоминать можно через \(afterMonths.lowerBound)–\(afterMonths.upperBound) месяца после визита."
        }
        if let issue = timeIssue(winback.sendAt) { return issue }
        if let issue = textIssue(winback.text, what: "Текст сообщения") { return issue }
        if let issue = giftIssue(amount: winback.bonusAmount, days: winback.bonusDays) { return issue }
        if !dailyLimit.contains(winback.dailyLimit) {
            return "В день — от \(dailyLimit.lowerBound) до \(dailyLimit.upperBound) сообщений."
        }
        return nil
    }

    static func certificatesIssue(_ certificates: CertificateSettings) -> String? {
        guard let months = certificates.validityMonths, !validityMonths.contains(months) else { return nil }
        return "Срок действия — от \(validityMonths.lowerBound) до \(validityMonths.upperBound) месяцев."
    }

    /// Length of a greeting as the server counts it.
    static func length(_ text: String) -> Int { text.trimmed.utf16.count }

    private static func textIssue(_ text: String, what: String) -> String? {
        let length = length(text)
        if length < textLength.lowerBound { return "\(what) не может быть пустым." }
        if length > textLength.upperBound {
            return "\(what) — не длиннее \(group(textLength.upperBound)) символов (сейчас \(group(length)))."
        }
        return nil
    }

    private static func timeIssue(_ time: String) -> String? {
        WorkdayHours.minute(from: time) == nil ? "Время — в формате ЧЧ:ММ, например 10:00." : nil
    }

    private static func giftIssue(amount: Int, days: Int) -> String? {
        if !bonusAmount.contains(amount) {
            return "Подарок — от 0 до \(group(bonusAmount.upperBound)) бонусов."
        }
        if !bonusDays.contains(days) {
            return "Подарочные бонусы действуют от \(bonusDays.lowerBound) до \(bonusDays.upperBound) дней."
        }
        return nil
    }

    private static func group(_ number: Int) -> String { Money.group(UInt(max(0, number))) }
}
