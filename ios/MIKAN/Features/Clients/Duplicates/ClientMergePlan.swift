import Foundation

/// A field of the kept card that a merge may fill (docs/API.md «Clients» → «Merge»).
nonisolated enum ClientMergeField: String, CaseIterable, Sendable {
    case lastName
    case phone
    case birthday
    case telegramNick
    case telegramBot
    case instagram
    case source
    case notes

    var title: String {
        switch self {
        case .lastName: "Фамилия"
        case .phone: "Телефон"
        case .birthday: "Дата рождения"
        case .telegramNick: "Ник в Telegram"
        case .telegramBot: "Бот в Telegram"
        case .instagram: "Instagram"
        case .source: "Откуда узнал"
        case .notes: "Заметки"
        }
    }
}

/// Where a value of the merged card comes from.
nonisolated enum ClientMergeOrigin: Equatable, Sendable {
    /// The kept card's own value.
    case kept
    /// Taken from the merged card with this name.
    case filled(from: String)
    /// The notes of both cards, one after the other.
    case joined

    /// The note under a value that fills in: «Из карточки «Анна»», «Заметки обеих карточек».
    var caption: String? {
        switch self {
        case .kept: nil
        case let .filled(name): "Из карточки «\(name)»"
        case .joined: "Заметки обеих карточек"
        }
    }
}

/// What a merge did: the kept card, the cards that are gone and, when a later merge of several failed, why.
nonisolated struct ClientMergeOutcome: Sendable {
    let kept: Client
    let removedIds: [Int]
    let failure: String?
}

nonisolated struct ClientMergeLine: Identifiable, Equatable, Sendable {
    let field: ClientMergeField
    let value: String
    let origin: ClientMergeOrigin

    var id: ClientMergeField { field }
}

/// A merged card's value that does not carry over: the kept card has its own.
nonisolated struct ClientMergeLoss: Identifiable, Equatable, Sendable {
    let field: ClientMergeField
    let value: String
    /// The name of the card it was on.
    let from: String
    let fromId: Int

    var id: String { "\(field.rawValue):\(fromId)" }
}

/**
 What merging `sources` into `kept` gives, shown before confirming. Mirrors the server's rules: the kept card's empty
 fields take the merged cards' values (in order), notes are joined, a last name the first name already spells is not
 added, the Telegram link of the kept card wins.
 */
nonisolated struct ClientMergePlan: Sendable {
    let kept: Client
    let sources: [Client]
    /// The kept card's fields after the merge (only those with a value), in `ClientMergeField` order.
    let lines: [ClientMergeLine]
    let losses: [ClientMergeLoss]

    init(kept: Client, sources: [Client]) {
        self.kept = kept
        self.sources = sources.filter { $0.id != kept.id }
        var fold = MergeFold(kept: kept)
        for source in self.sources { fold.absorb(source) }
        lines = fold.lines
        losses = fold.losses
    }

    var filledFields: [ClientMergeField] { lines.filter { $0.origin != .kept }.map(\.field) }

    var movedVisits: Int { sources.reduce(0) { $0 + ($1.stats?.visits ?? 0) } }
    var movedSpent: Int { sources.reduce(0) { $0 + ($1.stats?.totalSpent ?? 0) } }
    var movedUpcoming: Int { sources.reduce(0) { $0 + ($1.stats?.upcomingAppointments ?? 0) } }

    /// «3 визита, покупки на 5 500 ₽, 1 предстоящая запись»; `nil` when the merged cards have no visits or purchases.
    var movedSummary: String? {
        var parts: [String] = []
        if movedVisits > 0 { parts.append(Plural.count(movedVisits, one: "визит", few: "визита", many: "визитов")) }
        if movedSpent > 0 { parts.append("покупки на \(Money.format(movedSpent))") }
        if movedUpcoming > 0 {
            parts.append(Plural.count(movedUpcoming, one: "предстоящая запись", few: "предстоящие записи", many: "предстоящих записей"))
        }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// What the confirmation says: what moves, what fills in, which cards disappear.
    var confirmationMessage: String {
        let target = "«\(kept.fullName)»"
        let everything = "бонусы, сертификаты, переписка в Telegram и история"
        var sentences = [
            movedSummary.map { "К карточке \(target) перейдут \($0), а также \(everything)." }
                ?? "К карточке \(target) перейдут \(everything).",
        ]
        if !filledFields.isEmpty {
            sentences.append("Заполнятся: \(filledFields.map { $0.title.lowercased() }.joined(separator: ", ")).")
        }
        let names = sources.map(Self.cardLabel).joined(separator: ", ")
        sentences.append(sources.count == 1 ? "Карточка \(names) исчезнет." : "Карточки \(names) исчезнут.")
        sentences.append("Отменить объединение нельзя.")
        return sentences.joined(separator: " ")
    }

    /// «Анна» (+7 999 000-00-02)
    static func cardLabel(_ client: Client) -> String {
        let phone = client.phone.nonEmpty.map { " (\(PhoneText.display($0)))" } ?? ""
        return "«\(client.fullName)»\(phone)"
    }
}

/// The card to keep and the cards merged by default.
nonisolated enum ClientMergeDefaults {
    /// The card with the most visits, then the most spent; on a tie the earlier one in the list.
    static func kept(among clients: [Client]) -> Client? {
        clients.enumerated().max { a, b in
            let left = (a.element.stats?.visits ?? 0, a.element.stats?.totalSpent ?? 0, -a.offset)
            let right = (b.element.stats?.visits ?? 0, b.element.stats?.totalSpent ?? 0, -b.offset)
            return left < right
        }?.element
    }

    /// Of two cards the other one; in a bigger group none — staff tick the ones that are the same person.
    static func selected(in clients: [Client], keptId: Int) -> Set<Int> {
        guard clients.count == 2 else { return [] }
        return Set(clients.map(\.id).filter { $0 != keptId })
    }
}

/// The kept card's values while merged cards are absorbed one by one.
nonisolated struct MergeFold {
    private nonisolated struct Value {
        let raw: String
        let origin: ClientMergeOrigin
    }

    private let keptNameWords: Set<String>
    private var values: [ClientMergeField: Value] = [:]
    private(set) var losses: [ClientMergeLoss] = []

    init(kept: Client) {
        keptNameWords = Set(Self.words(kept.name))
        let own: [ClientMergeField: String?] = [
            .lastName: kept.lastName, .phone: kept.phone, .birthday: kept.birthday, .telegramNick: kept.telegramNick,
            .instagram: kept.instagram, .source: kept.source, .notes: kept.notes,
        ]
        for (field, raw) in own {
            if let raw = raw.nonEmpty { values[field] = Value(raw: raw, origin: .kept) }
        }
        if kept.telegramLinked { values[.telegramBot] = Value(raw: kept.telegramUsername.nonEmpty ?? "", origin: .kept) }
    }

    var lines: [ClientMergeLine] {
        ClientMergeField.allCases.compactMap { field in
            values[field].map { ClientMergeLine(field: field, value: Self.display(field, $0.raw), origin: $0.origin) }
        }
    }

    mutating func absorb(_ source: Client) {
        let name = source.fullName
        // An older card holds the whole name in `name`: what follows the first name is its last name.
        let lastName = source.lastName.nonEmpty ?? PersonName.split(source.name).last.nonEmpty
        if !holdsLastName(lastName) { fill(.lastName, lastName, from: source) }
        fill(.phone, source.phone, from: source)
        fill(.birthday, source.birthday, from: source)
        fill(.telegramNick, source.telegramNick, from: source)
        fill(.instagram, source.instagram, from: source)
        fill(.source, source.source, from: source)
        join(notes: source.notes, from: name)
        if values[.telegramBot] == nil, source.telegramLinked {
            values[.telegramBot] = Value(raw: source.telegramUsername.nonEmpty ?? "", origin: .filled(from: name))
        }
    }

    /// The kept card already spells this last name in its first name («Анна Иванова» in `name`).
    private func holdsLastName(_ lastName: String?) -> Bool {
        guard values[.lastName] == nil, let words = lastName.nonEmpty.map(Self.words) else { return false }
        return words.allSatisfy(keptNameWords.contains)
    }

    private mutating func fill(_ field: ClientMergeField, _ value: String?, from source: Client) {
        guard let incoming = value.nonEmpty else { return }
        guard let current = values[field] else {
            values[field] = Value(raw: incoming, origin: .filled(from: source.fullName))
            return
        }
        if Self.key(current.raw) != Self.key(incoming) {
            losses.append(
                ClientMergeLoss(field: field, value: Self.display(field, incoming), from: source.fullName, fromId: source.id)
            )
        }
    }

    /// Both texts, the kept card's first; a text the other already contains is not repeated.
    private mutating func join(notes: String?, from name: String) {
        guard let incoming = notes.nonEmpty else { return }
        guard let current = values[.notes] else {
            values[.notes] = Value(raw: incoming, origin: .filled(from: name))
            return
        }
        if current.raw.contains(incoming) { return }
        if incoming.contains(current.raw) {
            values[.notes] = Value(raw: incoming, origin: .filled(from: name))
        } else {
            values[.notes] = Value(raw: "\(current.raw)\n\n\(incoming)", origin: .joined)
        }
    }

    private static func words(_ text: String) -> [String] {
        key(text).split(separator: " ").map(String.init)
    }

    /// Case-insensitive, `ё` = `е`, spaces collapsed.
    static func key(_ text: String) -> String {
        text.lowercased()
            .replacingOccurrences(of: "ё", with: "е")
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }

    static func display(_ field: ClientMergeField, _ raw: String) -> String {
        switch field {
        case .phone: PhoneText.display(raw)
        case .birthday: Birthday(raw)?.text ?? raw
        case .telegramNick, .instagram: "@\(raw)"
        case .telegramBot: raw.isEmpty ? "Подключён" : "Подключён · @\(raw)"
        case .source: ClientSource.title(for: raw)
        case .lastName, .notes: raw
        }
    }
}

/// One line of the side-by-side comparison of a duplicate group.
nonisolated struct DuplicateComparisonRow: Identifiable, Equatable, Sendable {
    let title: String
    /// One per card, in the group's order; `nil` — empty.
    let values: [String?]
    /// Who the person is (name, phone, handles, birthday) rather than their history: a difference there matters.
    let isIdentity: Bool
    /// What is compared, per card: case, `ё` and spaces aside; Telegram by the handle only.
    var keys: [String?] = []

    var id: String { title }
    /// Two cards hold different values here (an empty one does not count).
    var conflicts: Bool { isIdentity && Set((keys.isEmpty ? values : keys).compactMap { $0 }).count > 1 }
}

nonisolated enum DuplicateComparison {
    /// Name, phone, visits, spent, last visit and Telegram for every card; Instagram and the birthday when any card has one.
    static func rows(_ clients: [Client]) -> [DuplicateComparisonRow] {
        let always = [
            row("Имя", clients, identity: true) { $0.fullName.nonEmpty },
            row("Телефон", clients, identity: true) { $0.phone.nonEmpty.map(PhoneText.display) },
            row("Визиты", clients) { $0.stats.map { String($0.visits) } },
            row("Потрачено", clients) { $0.stats.map { Money.format($0.totalSpent) } },
            row("Последний визит", clients) { $0.stats?.lastVisitAt.map(DateText.fullDate) },
            row("Telegram", clients, identity: true, value: telegram, key: { $0.telegramHandle.map(MergeFold.key) }),
        ]
        let optional = [
            row("Instagram", clients, identity: true) { $0.instagram.nonEmpty.map { "@\($0)" } },
            row("Дата рождения", clients, identity: true) { client in
                client.birthday.nonEmpty.map { Birthday($0)?.text ?? $0 }
            },
        ]
        return always + optional.filter { $0.values.contains { $0 != nil } }
    }

    /// «@anna · бот», «Бот подключён», «@anna» or nothing.
    static func telegram(_ client: Client) -> String? {
        switch (client.telegramHandle, client.telegramLinked) {
        case let (handle?, true): "@\(handle) · бот"
        case (nil, true): "Бот подключён"
        case let (handle?, false): "@\(handle)"
        case (nil, false): nil
        }
    }

    private static func row(
        _ title: String,
        _ clients: [Client],
        identity: Bool = false,
        value: (Client) -> String?,
        key: ((Client) -> String?)? = nil
    ) -> DuplicateComparisonRow {
        let values = clients.map(value)
        let keys = key.map { clients.map($0) } ?? values.map { $0.map(MergeFold.key) }
        return DuplicateComparisonRow(title: title, values: values, isIdentity: identity, keys: keys)
    }
}
