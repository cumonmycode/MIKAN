import Foundation

/// The client card being edited: name, last name, birthday, phone, Telegram nick and the rest.
/// Only the name and the phone are required. A card imported without a phone (YCLIENTS) can still be saved
/// without one, so its other fields stay editable; a phone, once set, can be changed but not removed.
nonisolated struct ClientDraft: Equatable, Sendable {
    static let defaultBirthday = Calendar.app.date(from: DateComponents(year: 1995, month: 1, day: 1)) ?? .now

    var name = ""
    var lastName = ""
    var phone = ""
    var telegramNick = ""
    var instagram = ""
    var hasBirthday = false
    /// The full date, while the year is known.
    var birthday = ClientDraft.defaultBirthday
    /// «Без года»: only `birthdayDay` and `birthdayMonth` count (sent with the year 1900). Switching carries the day
    /// and the month over.
    var birthdayWithoutYear = false {
        didSet { if birthdayWithoutYear != oldValue { carryBirthdayOver() } }
    }
    var birthdayDay = 1
    var birthdayMonth = 1 {
        didSet { birthdayDay = min(birthdayDay, Birthday.daysIn(month: birthdayMonth, year: nil)) }
    }
    var source = ""
    var notes = ""
    var botEnabled = true
    /// `false` only for a saved card that has no phone yet.
    let requiresPhone: Bool

    /// A new card.
    init() {
        requiresPhone = true
    }

    /// A blank card prefilled from a name typed in one line and a phone (e.g. a booking request).
    init(suggestedName: String, phone: String) {
        let parts = PersonName.split(suggestedName)
        self.init()
        name = parts.first
        lastName = parts.last
        self.phone = phone
    }

    /// An existing card.
    init(client: Client) {
        requiresPhone = client.phone.nonEmpty != nil
        name = client.name
        lastName = client.lastName ?? ""
        phone = client.phone ?? ""
        telegramNick = client.telegramNick ?? ""
        instagram = client.instagram ?? ""
        let stored = Birthday(client.birthday)
        hasBirthday = stored != nil
        birthdayWithoutYear = stored != nil && stored?.year == nil
        birthdayDay = stored?.day ?? 1
        birthdayMonth = stored?.month ?? 1
        birthday = stored?.year == nil ? Self.defaultBirthday : (stored?.date ?? Self.defaultBirthday)
        source = client.source ?? ""
        notes = client.notes ?? ""
        botEnabled = client.botEnabled
    }

    var fullName: String { PersonName.full(name, lastName) }

    /// The birthday to send: `nil` when not given; the year 1900 when «Без года».
    var birthdayValue: Birthday? {
        guard hasBirthday else { return nil }
        if birthdayWithoutYear { return Birthday(day: birthdayDay, month: birthdayMonth, year: nil) }
        let parts = Calendar.app.dateComponents([.year, .month, .day], from: birthday)
        return Birthday(day: parts.day ?? 1, month: parts.month ?? 1, year: parts.year)
    }
    var isMissingName: Bool { name.trimmed.isEmpty }
    var isMissingPhone: Bool { requiresPhone && phone.trimmed.isEmpty }
    var canSave: Bool { !isMissingName && !isMissingPhone }

    /// What still blocks saving, for the form's footer: "Укажите имя и телефон.".
    var missingFieldsHint: String? {
        switch (isMissingName, isMissingPhone) {
        case (true, true): "Укажите имя и телефон."
        case (true, false): "Укажите имя."
        case (false, true): "Укажите телефон."
        case (false, false): nil
        }
    }

    func body() -> ClientBody {
        ClientBody(
            name: name.trimmed,
            lastName: Nullable(lastName.nonEmpty),
            phone: Nullable(phone.nonEmpty),
            instagram: Nullable(Self.handle(instagram)),
            telegramNick: Nullable(Self.handle(telegramNick)),
            birthday: Nullable(birthdayValue?.string),
            notes: Nullable(notes.nonEmpty),
            source: Nullable(source.nonEmpty),
            botEnabled: botEnabled
        )
    }

    /// «Без года» on: the day and the month of the full date; off: they go back into it (with its year, not past today).
    private mutating func carryBirthdayOver() {
        let calendar = Calendar.app
        if birthdayWithoutYear {
            let parts = calendar.dateComponents([.month, .day], from: birthday)
            birthdayMonth = parts.month ?? 1
            birthdayDay = parts.day ?? 1
            return
        }
        let year = calendar.component(.year, from: birthday)
        let day = min(birthdayDay, Birthday.daysIn(month: birthdayMonth, year: year))
        let date = calendar.date(from: DateComponents(year: year, month: birthdayMonth, day: day)) ?? birthday
        birthday = min(date, .now)
    }

    /// "@nick", "t.me/nick" or "https://instagram.com/nick/" → "nick"; `nil` when empty.
    static func handle(_ text: String) -> String? {
        var value = text.trimmed
        for prefix in ["https://", "http://", "www.", "t.me/", "telegram.me/", "instagram.com/", "@"]
        where value.lowercased().hasPrefix(prefix) {
            value.removeFirst(prefix.count)
        }
        while value.hasSuffix("/") { value.removeLast() }
        return value.nonEmpty
    }
}
