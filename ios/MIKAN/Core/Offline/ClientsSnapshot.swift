import Foundation

/// The client list kept on the phone: the active clients the list screen loaded, in its order, and the server's total.
/// Offline it is searched on the phone.
nonisolated struct ClientsSnapshot: Codable, Equatable, Sendable {
    private(set) var items: [Client]
    private(set) var total: Int

    init(items: [Client], total: Int) {
        self.items = items
        self.total = total
    }

    /// The first page starts the copy again; further pages are added to it (without repeats).
    static func saving(_ page: [Client], offset: Int, total: Int, into saved: ClientsSnapshot?) -> ClientsSnapshot {
        guard offset > 0, let saved else { return ClientsSnapshot(items: page, total: total) }
        let known = Set(saved.items.map(\.id))
        return ClientsSnapshot(items: saved.items + page.filter { !known.contains($0.id) }, total: total)
    }

    /// A page of the list without a network: only the saved clients, searched on the phone.
    func page(search: String, limit: Int, offset: Int) -> ItemsResponse<Client> {
        let found = items.filter { Self.matches($0, search: search) }
        return ItemsResponse(items: Array(found.dropFirst(offset).prefix(limit)), total: found.count)
    }

    /// Every word of the search is in the name, last name, Instagram or Telegram handle — or, with at least three
    /// digits, in the phone number.
    static func matches(_ client: Client, search: String) -> Bool {
        let words = search.trimmed.lowercased().split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return true }
        let text = [client.name, client.lastName, client.instagram, client.telegramHandle]
            .compactMap { $0?.lowercased() }
            .joined(separator: " ")
        let phone = digits(client.phone ?? "")
        return words.allSatisfy { word in
            let wordDigits = digits(String(word))
            return text.contains(word) || (wordDigits.count >= 3 && phone.contains(wordDigits))
        }
    }

    private static func digits(_ text: String) -> String {
        text.filter(\.isNumber)
    }
}
