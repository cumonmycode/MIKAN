import Foundation

/// A drop waiting for «Перенести».
nonisolated struct AppointmentMove: Identifiable, Sendable {
    let appointment: Appointment
    let target: DragTarget

    var id: Int { appointment.id }
    var changesTime: Bool { target.startsAt != appointment.startsAt }
    var changesMaster: Bool { target.masterId != appointment.master.id }
    var isChange: Bool { changesTime || changesMaster }

    /// «Уведомить клиента в Telegram» is offered for a new time still ahead, to a client with Telegram.
    func offersTelegramNotice(now: Date = .now) -> Bool {
        changesTime && appointment.client.telegramLinked && target.startsAt > now
    }

    func body(
        notifyClient: Bool,
        force: Bool,
        repricing: AppointmentMoveRepricing? = nil,
        now: Date = .now
    ) -> AppointmentMoveBody {
        AppointmentMoveBody(
            startsAt: target.startsAt,
            endsAt: target.endsAt,
            masterId: changesMaster ? target.masterId : nil,
            notifyClient: notifyClient && offersTelegramNotice(now: now),
            force: force ? true : nil,
            services: repricing?.services,
            price: repricing?.price,
            depositRequired: repricing.map { _ in appointment.depositRequired }
        )
    }
}

/// New prices of a move to another master (docs/API.md «Service» `masterPrices`): as in the editor, the catalog
/// lines nobody edited take the new master's prices.
nonisolated struct AppointmentMoveRepricing: Equatable, Sendable {
    let services: [AppointmentServiceBody]
    /// The new total: the sum of the lines (a kept total gives way to it, as in the editor).
    let price: Int
}

extension AppointmentMove {
    /// `nil` when the master stays, the catalog is not loaded or no price changes.
    @MainActor
    func repricing(catalog: [Service]) -> AppointmentMoveRepricing? {
        guard changesMaster, !catalog.isEmpty else { return nil }
        var draft = AppointmentDraft.edit(appointment, catalog: catalog)
        let before = draft.lines.map(\.price)
        draft.masterId = target.masterId
        draft.repriceLines(from: catalog)
        guard draft.lines.map(\.price) != before else { return nil }
        return AppointmentMoveRepricing(services: draft.lines.map(\.body), price: draft.total)
    }
}

/// Texts of the move confirmation.
nonisolated enum AppointmentMoveText {
    /// «21 октября, 15:00»; «21 октября 2027 г., 15:00» in another year.
    static func moment(_ date: Date, now: Date = .now, calendar: Calendar = .app) -> String {
        let sameYear = calendar.isDate(date, equalTo: now, toGranularity: .year)
        return "\(sameYear ? DateText.dayMonth(date) : DateText.fullDate(date)), \(DateText.time(date))"
    }

    /// «вторник, 20 октября, 14:00–15:00»
    static func slot(_ start: Date, _ end: Date) -> String {
        "\(DateText.weekdayDayMonth(start)), \(DateText.timeRange(start, end))"
    }

    /// «Перенести запись Анны на 21 октября, 15:00?»; without the name when it can't be declined.
    static func question(_ move: AppointmentMove, now: Date = .now) -> String {
        let firstName = move.appointment.client.name.split(separator: " ").first.map(String.init) ?? ""
        let owner = genitive(firstName).map { " \($0)" } ?? ""
        guard move.changesTime else { return "Передать запись\(owner) другому мастеру?" }
        return "Перенести запись\(owner) на \(moment(move.target.startsAt, now: now))?"
    }

    private static let fleetingVowel = ["павел": "Павла", "пётр": "Петра", "петр": "Петра", "лев": "Льва"]
    private static let hissingOrVelar = Set("гкхжчшщ")
    private static let consonants = Set("бвгджзклмнпрстфхцчшщ")
    private static let cyrillic = Set("абвгдеёжзийклмнопрстуфхцчшщъыьэюя")

    /// «Анна» → «Анны», «Ольга» → «Ольги», «Мария» → «Марии», «Иван» → «Ивана», «Андрей» → «Андрея».
    /// `nil` when unsure: names ending in «ь» (Игорь / Любовь), a vowel, or not a single Cyrillic word.
    static func genitive(_ firstName: String) -> String? {
        let name = firstName.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = name.lowercased()
        guard lower.count >= 2, lower.allSatisfy(cyrillic.contains), let last = lower.last else { return nil }
        if let known = fleetingVowel[lower] { return known }
        let shouts = name == name.uppercased()
        let stem = String(name.dropLast())
        func with(_ ending: String, keepingLast: Bool = false) -> String {
            (keepingLast ? name : stem) + (shouts ? ending.uppercased() : ending)
        }
        switch last {
        case "а":
            let before = lower.dropLast().last
            return with(before.map(hissingOrVelar.contains) == true ? "и" : "ы")
        case "я":
            return with("и")
        case "й":
            return with("я")
        case _ where consonants.contains(last):
            return with("а", keepingLast: true)
        default:
            return nil
        }
    }
}
