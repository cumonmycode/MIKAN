import SwiftUI

/// Retention settings: the bonus programme — cashback, how much of a check bonuses may pay, expiry, client notices.
struct LoyaltySettingsSection: View {
    @Binding var loyalty: LoyaltySettings

    private static let paymentStep = 5

    var body: some View {
        Section {
            Toggle("Бонусная программа", isOn: $loyalty.enabled.animation())
            // Switched off, the details fold away — unless one of them must be fixed (the server checks every field).
            if loyalty.enabled || RetentionRules.loyaltyIssue(loyalty) != nil {
                Stepper(value: $loyalty.cashbackPercent, in: RetentionRules.cashbackPercent) {
                    RetentionValueRow(title: "Кешбэк", value: "\(loyalty.cashbackPercent)%")
                }
                Stepper(value: $loyalty.maxPaymentPercent, in: RetentionRules.maxPaymentPercent, step: Self.paymentStep) {
                    RetentionValueRow(title: "Оплата бонусами", value: "до \(loyalty.maxPaymentPercent)% чека")
                }
                Toggle("Бонусы сгорают", isOn: expires.animation())
                if loyalty.expiryDays != nil {
                    NumberField.integer("Через", value: expiryDays, unit: "дн.")
                }
                Toggle("Сообщать клиенту о начислении", isOn: $loyalty.notifyClient)
            }
        } header: {
            Text("Бонусы")
        } footer: {
            if let issue = RetentionRules.loyaltyIssue(loyalty) {
                Text(issue).foregroundStyle(.red)
            } else if loyalty.enabled {
                Text("1 бонус = 1 ₽. Бонусы начисляются с оплаченной суммы и тратятся на кассе — сначала самые старые. Бот пишет клиенту: «+75 бонусов, на счёте 1 275».")
            } else {
                Text("Выключено — бонусы не начисляются и не тратятся, накопленные остаются на счетах.")
            }
        }
    }

    private var expires: Binding<Bool> {
        Binding {
            loyalty.expiryDays != nil
        } set: { isOn in
            loyalty.expiryDays = isOn ? (loyalty.expiryDays ?? RetentionRules.defaultExpiryDays) : nil
        }
    }

    /// An emptied field reads as 0 (and asks for a number) instead of switching expiry off.
    private var expiryDays: Binding<Int> {
        Binding { loyalty.expiryDays ?? 0 } set: { loyalty.expiryDays = $0 }
    }
}

/// Retention settings: how long a newly sold gift certificate is valid.
struct CertificateSettingsSection: View {
    @Binding var certificates: CertificateSettings

    var body: some View {
        Section {
            Toggle("Ограниченный срок действия", isOn: limited.animation())
            if let months = certificates.validityMonths {
                Stepper(value: validityMonths, in: RetentionRules.validityMonths) {
                    RetentionValueRow(title: "Действует", value: CampaignSegmentText.months(months))
                }
            }
        } header: {
            Text("Подарочные сертификаты")
        } footer: {
            if let issue = RetentionRules.certificatesIssue(certificates) {
                Text(issue).foregroundStyle(.red)
            } else {
                Text("Срок считается с дня продажи. Уже проданные сертификаты не меняются.")
            }
        }
    }

    private var limited: Binding<Bool> {
        Binding {
            certificates.validityMonths != nil
        } set: { isOn in
            certificates.validityMonths = isOn ? (certificates.validityMonths ?? RetentionRules.defaultValidityMonths) : nil
        }
    }

    private var validityMonths: Binding<Int> {
        Binding {
            certificates.validityMonths ?? RetentionRules.defaultValidityMonths
        } set: {
            certificates.validityMonths = $0
        }
    }
}

/// «Кешбэк ……… 5%» inside a stepper.
struct RetentionValueRow: View {
    let title: String
    let value: String

    var body: some View {
        HStack {
            Text(title)
            Spacer(minLength: 8)
            Text(value)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
    }
}
