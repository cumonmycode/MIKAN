import SwiftUI

/// «Касса»: whether the bot sends the receipt to the client's Telegram (`StudioSettings.pos`).
struct PosSettingsSection: View {
    @Binding var settings: PosSettings

    var body: some View {
        Section {
            Toggle("Отправлять чек клиенту в Telegram", isOn: $settings.sendReceipt)
        } header: {
            Text("Касса")
        } footer: {
            Text("Если у клиента подключён Telegram, бот пришлёт чек после оплаты и сообщит о возврате.")
        }
    }
}

/// «Отмена и предоплата»: what the studio keeps of a prepayment when a visit is cancelled late or missed.
struct CancellationRulesSection: View {
    @Binding var rules: CancellationRules

    var body: some View {
        Section {
            Picker("Бесплатная отмена", selection: $rules.freeHours) {
                ForEach(CancellationRulesOptions.freeHours(including: rules.freeHours), id: \.self) { hours in
                    Text(CancellationRulesOptions.freeHoursTitle(hours)).tag(hours)
                }
            }
            percentPicker(CancellationRulesOptions.lateRetainTitle(freeHours: rules.freeHours), selection: $rules.lateRetainPercent)
            percentPicker("Удерживать при неявке", selection: $rules.noShowRetainPercent)
            Toggle("Удерживать автоматически", isOn: $rules.autoRetain)
        } header: {
            Text("Отмена и предоплата")
        } footer: {
            Text(CancellationRulesOptions.footer(rules))
        }
        .monospacedDigit()
    }

    private func percentPicker(_ title: String, selection: Binding<Int>) -> some View {
        Picker(title, selection: selection) {
            ForEach(CancellationRulesOptions.percents(including: selection.wrappedValue), id: \.self) { percent in
                Text(CancellationRulesOptions.percentTitle(percent)).tag(percent)
            }
        }
    }
}

/// «Отзывы»: links to the studio's review pages, offered by the bot after a healing check-in.
struct ReviewLinksSection: View {
    @Binding var links: ReviewLinks

    var body: some View {
        Section {
            linkField("Яндекс Карты", text: $links.yandex)
            linkField("2ГИС", text: $links.twogis)
            linkField("Google", text: $links.google)
        } header: {
            Text("Отзывы")
        } footer: {
            if let issue = ReviewLinksRules.issue(links) {
                Text(issue).foregroundStyle(.red)
            } else {
                Text("Ссылки на страницы отзывов о студии. Бот предложит оставить отзыв, когда клиент напишет, что всё хорошо заживает.")
            }
        }
    }

    private func linkField(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("https://…", text: text)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        .accessibilityElement(children: .combine)
    }
}

/// Choices and texts of «Отмена и предоплата».
enum CancellationRulesOptions {
    static let freeHourChoices = [0, 1, 2, 3, 4, 6, 8, 12, 24, 36, 48, 72, 96, 120, 168, CancellationRules.maxFreeHours]
    static let percentChoices = [0, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 100]

    /// The choices plus a value set elsewhere (so the picker can show it).
    static func freeHours(including current: Int) -> [Int] { merged(freeHourChoices, current) }
    static func percents(including current: Int) -> [Int] { merged(percentChoices, current) }

    /// «Не предусмотрена», «за 24 ч».
    static func freeHoursTitle(_ hours: Int) -> String {
        hours <= 0 ? "Не предусмотрена" : "за \(hours) ч"
    }

    static func percentTitle(_ percent: Int) -> String { "\(percent) %" }

    /// Without a free cancellation every cancellation counts.
    static func lateRetainTitle(freeHours: Int) -> String {
        freeHours > 0 ? "Удерживать при поздней отмене" : "Удерживать при отмене"
    }

    static func footer(_ rules: CancellationRules) -> String {
        let told = "Бот рассказывает эти правила клиентам, которые записываются с предоплатой."
        let applied = rules.autoRetain
            ? "При поздней отмене или неявке удержание запишется само, остаток предоплаты можно вернуть клиенту в карточке записи."
            : "При отмене или неявке приложение подскажет сумму по правилам, а вернуть или удержать предоплату — решаете вы."
        return "\(told) \(applied)"
    }

    private static func merged(_ choices: [Int], _ current: Int) -> [Int] {
        choices.contains(current) ? choices : (choices + [current]).sorted()
    }
}

/// Validation of the review links: `https://…` or empty, at most 500 characters.
enum ReviewLinksRules {
    static let maxLength = 500

    /// What blocks saving, or `nil`.
    static func issue(_ links: ReviewLinks) -> String? {
        let named = [("Яндекс Карты", links.yandex), ("2ГИС", links.twogis), ("Google", links.google)]
        for (name, value) in named {
            let link = value.trimmed
            if link.isEmpty { continue }
            if link.count > maxLength { return "Ссылка «\(name)» слишком длинная." }
            if !isHTTPS(link) { return "Ссылка «\(name)» должна начинаться с https://" }
        }
        return nil
    }

    static func isHTTPS(_ link: String) -> Bool {
        guard let url = URL(string: link), url.scheme?.lowercased() == "https" else { return false }
        return url.host()?.isEmpty == false
    }
}
