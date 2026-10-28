import SwiftUI

/// Retention settings: the birthday greeting with gift bonuses, and the checkout discount around the birthday.
struct BirthdaySettingsSections: View {
    @Binding var birthday: BirthdaySettings

    private static let defaultTime = "10:00"
    private static let discountStep = 5

    var body: some View {
        Section {
            Toggle("Поздравлять в Telegram", isOn: $birthday.enabled.animation())
            // Switched off, the details fold away — unless one of them must be fixed (the server checks every field).
            if birthday.enabled || RetentionRules.birthdayIssue(birthday) != nil {
                StudioTimePicker(title: "Время отправки", time: $birthday.sendAt, fallback: Self.defaultTime)
                NameTokenTextField(
                    placeholder: "Текст поздравления",
                    text: $birthday.text,
                    limit: RetentionRules.textLength.upperBound,
                    lineLimit: 3...8
                )
                GiftBonusRows(amount: $birthday.bonusAmount, days: $birthday.bonusDays)
            }
        } header: {
            Text("День рождения")
        } footer: {
            if let issue = RetentionRules.birthdayIssue(birthday) {
                Text(issue).foregroundStyle(.red)
            } else {
                Text("Бот поздравит клиента в день рождения по времени студии — раз в год, если клиент не отказался от новостей. О подарке бот допишет сам.")
            }
        }
        Section {
            Stepper(value: $birthday.discountPercent.animation(), in: RetentionRules.discountPercent, step: Self.discountStep) {
                RetentionValueRow(title: "Скидка", value: birthday.discountPercent == 0 ? "нет" : "\(birthday.discountPercent)%")
            }
            if birthday.discountPercent > 0 {
                Stepper(value: $birthday.discountDaysBefore, in: RetentionRules.discountWindowDays) {
                    RetentionValueRow(title: "За дней до", value: "\(birthday.discountDaysBefore)")
                }
                Stepper(value: $birthday.discountDaysAfter, in: RetentionRules.discountWindowDays) {
                    RetentionValueRow(title: "Дней после", value: "\(birthday.discountDaysAfter)")
                }
            }
        } header: {
            Text("Скидка на день рождения")
        } footer: {
            Text("Касса подскажет скидку, если день рождения клиента попадает в это окно.")
        }
    }
}

/// Retention settings: one message to clients who have not come for a while, with «📅 Записаться».
struct WinbackSettingsSection: View {
    @Binding var winback: WinbackSettings

    private static let defaultTime = "12:00"

    var body: some View {
        Section {
            Toggle("Звать вернуться", isOn: $winback.enabled.animation())
            if winback.enabled || RetentionRules.winbackIssue(winback) != nil {
                Stepper(value: $winback.afterMonths, in: RetentionRules.afterMonths) {
                    RetentionValueRow(title: "Без визитов", value: CampaignSegmentText.months(winback.afterMonths))
                }
                StudioTimePicker(title: "Время отправки", time: $winback.sendAt, fallback: Self.defaultTime)
                NameTokenTextField(
                    placeholder: "Текст сообщения",
                    text: $winback.text,
                    limit: RetentionRules.textLength.upperBound,
                    lineLimit: 3...8
                )
                GiftBonusRows(amount: $winback.bonusAmount, days: $winback.bonusDays)
                NumberField.integer("Не больше в день", value: $winback.dailyLimit, unit: "сообщ.")
            }
        } header: {
            Text("Давно не были")
        } footer: {
            if let issue = RetentionRules.winbackIssue(winback) {
                Text(issue).foregroundStyle(.red)
            } else {
                Text("Одно сообщение с кнопкой «\(CampaignButton.bookTitle)» тем, кто давно не приходил и ни к кому не записан. Сначала — те, кого не было дольше всех.")
            }
        }
    }
}

/// Gift bonuses of a greeting: the amount (0 — none) and, when there is one, how long they last. The days stay
/// visible while out of range: the server checks them even without a gift.
struct GiftBonusRows: View {
    @Binding var amount: Int
    @Binding var days: Int

    var body: some View {
        NumberField.integer("Подарок", value: $amount, unit: "бонусов")
        if amount > 0 || !RetentionRules.bonusDays.contains(days) {
            NumberField.integer("Сгорают через", value: $days, unit: "дн.")
        }
    }
}

/// "HH:MM" in studio time edited with a wheel: the picker works in UTC (`DigestTime`), so the phone's own time zone
/// never shifts the value.
struct StudioTimePicker: View {
    let title: String
    @Binding var time: String
    /// Shown while the stored value is malformed.
    let fallback: String

    var body: some View {
        DatePicker(title, selection: date, displayedComponents: .hourAndMinute)
            .environment(\.timeZone, DigestTime.timeZone)
    }

    private var date: Binding<Date> {
        Binding {
            DigestTime.date(from: time) ?? DigestTime.date(from: fallback) ?? .now
        } set: { date in
            time = DigestTime.text(from: date)
        }
    }
}
