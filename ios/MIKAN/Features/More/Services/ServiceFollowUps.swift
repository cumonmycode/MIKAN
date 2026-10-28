import Foundation

// Post-visit follow-ups of a service: the bot asks «Как заживает?» and suggests a jewelry change (docs/API.md → Service).

/// Limits and defaults of `Service.healingCheckDays` / `jewelryChangeWeeks`.
nonisolated enum ServiceFollowUpLimits {
    static let healingDays = 1...60
    static let jewelryWeeks = 1...52
    /// A new service — or a switch turned on for the first time — asks after a week.
    static let defaultHealingDays = 7
    /// The swelling is usually gone by then and a shorter bar fits.
    static let defaultJewelryWeeks = 6
}

/// «После визита» in the service editor. The days and weeks are kept while their switch is off.
nonisolated struct ServiceFollowUpDraft: Hashable, Sendable {
    var asksHealing: Bool
    var healingDays: Int
    var remindsJewelryChange: Bool
    var jewelryWeeks: Int

    init(healingCheckDays: Int?, jewelryChangeWeeks: Int?) {
        asksHealing = healingCheckDays != nil
        healingDays = healingCheckDays ?? ServiceFollowUpLimits.defaultHealingDays
        remindsJewelryChange = jewelryChangeWeeks != nil
        jewelryWeeks = jewelryChangeWeeks ?? ServiceFollowUpLimits.defaultJewelryWeeks
    }

    /// A new service asks how it heals after a week, as the server does for a new fresh procedure.
    static var newService: ServiceFollowUpDraft {
        ServiceFollowUpDraft(healingCheckDays: ServiceFollowUpLimits.defaultHealingDays, jewelryChangeWeeks: nil)
    }

    /// `ServiceBody.healingCheckDays`: `nil` while the switch is off.
    var healingCheckDays: Int? {
        asksHealing ? Self.clamp(healingDays, to: ServiceFollowUpLimits.healingDays) : nil
    }

    /// `ServiceBody.jewelryChangeWeeks`: `nil` while the switch is off.
    var jewelryChangeWeeks: Int? {
        remindsJewelryChange ? Self.clamp(jewelryWeeks, to: ServiceFollowUpLimits.jewelryWeeks) : nil
    }

    /// The jewelry change is a piercing matter: other categories show the switch only while it is on, so it can be
    /// turned off (e.g. after the category changed).
    func showsJewelryChange(for category: ServiceCategory) -> Bool {
        category == .piercing || remindsJewelryChange
    }

    /// Footer of the section: what the client gets.
    var hint: String {
        var lines: [String] = []
        if asksHealing {
            lines.append("Бот спросит клиента, как заживает, и после ответа «Всё хорошо» предложит оставить отзыв.")
        }
        if remindsJewelryChange {
            lines.append("Напомнит заменить украшение на подходящее по размеру и предложит записаться.")
        }
        guard !lines.isEmpty else { return "После визита с этой услугой бот ничего не напишет." }
        return (lines + ["Только клиентам с подключённым Telegram."]).joined(separator: " ")
    }

    private static func clamp(_ value: Int, to range: ClosedRange<Int>) -> Int {
        min(max(value, range.lowerBound), range.upperBound)
    }
}

/// How the follow-ups read in the editor and the service card.
nonisolated enum ServiceFollowUpText {
    /// «7 дней».
    static func days(_ count: Int) -> String { Plural.days(count) }

    /// «6 недель», «1 неделю» (after «через»).
    static func weeks(_ count: Int) -> String {
        Plural.count(count, one: "неделю", few: "недели", many: "недель")
    }

    /// «Через 7 дней» or «Нет».
    static func healing(_ days: Int?) -> String {
        days.map { "Через \(Self.days($0))" } ?? "Нет"
    }

    /// «Через 6 недель» or «Нет».
    static func jewelryChange(_ weeks: Int?) -> String {
        weeks.map { "Через \(Self.weeks($0))" } ?? "Нет"
    }
}
