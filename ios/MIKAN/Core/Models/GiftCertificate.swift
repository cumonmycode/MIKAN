import Foundation

/// A gift certificate (docs/API.md «Gift certificates»): sold at the till as a sale line, spent in parts at checkout
/// until its balance is 0.
nonisolated struct GiftCertificate: Hashable, Identifiable, Sendable {
    let id: Int
    /// «MIKAN-7K3Q-9F2D».
    let code: String
    /// Nominal value it was sold for.
    let amount: Int
    var balance: Int
    var status: GiftCertificateStatus
    /// `nil` — never expires.
    var expiresAt: Date?
    var buyer: ClientRef?
    var recipientName: String?
    var note: String?
    /// The sale that issued it.
    var saleId: Int?
    var saleNumber: Int?
    /// Oldest first, as the server lists them.
    var operations: [GiftCertificateOperation] = []
    let createdAt: Date

    var isActive: Bool { status == .active }
    /// Spendable at checkout now: active, money left and not past `expiresAt`.
    func isSpendable(at date: Date = .now) -> Bool {
        guard isActive, balance > 0 else { return false }
        guard let expiresAt else { return true }
        return expiresAt > date
    }
}

nonisolated extension GiftCertificate: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, code, amount, balance, status, expiresAt, buyer, recipientName, note, saleId, saleNumber, operations
        case createdAt
    }

    /// Missing optional parts read as empty, so a slightly different server still shows the certificate.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        code = try c.decode(String.self, forKey: .code)
        amount = try c.decode(Int.self, forKey: .amount)
        balance = try c.decodeIfPresent(Int.self, forKey: .balance) ?? amount
        status = try c.decodeIfPresent(GiftCertificateStatus.self, forKey: .status) ?? .active
        expiresAt = try c.decodeIfPresent(Date.self, forKey: .expiresAt)
        buyer = try? c.decodeIfPresent(ClientRef.self, forKey: .buyer)
        recipientName = try c.decodeIfPresent(String.self, forKey: .recipientName)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        saleId = try c.decodeIfPresent(Int.self, forKey: .saleId)
        saleNumber = try c.decodeIfPresent(Int.self, forKey: .saleNumber)
        operations = (try? c.decodeIfPresent([GiftCertificateOperation].self, forKey: .operations)) ?? []
        createdAt = try c.decode(Date.self, forKey: .createdAt)
    }
}

nonisolated enum GiftCertificateStatus: String, Codable, CaseIterable, Sendable {
    case active
    case used
    case expired
    case cancelled
    /// A status from a newer server.
    case unknown

    /// The filter chips of the list, in order (`nil` — all).
    static let filters: [GiftCertificateStatus] = [.active, .used, .expired, .cancelled]
}

nonisolated extension GiftCertificateStatus {
    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = GiftCertificateStatus(rawValue: raw) ?? .unknown
    }
}

/// A movement of a certificate's balance, oldest first; Σ `amount` = `balance`.
nonisolated struct GiftCertificateOperation: Decodable, Hashable, Sendable {
    let type: GiftCertificateOperationType
    /// Signed: credits > 0, debits < 0.
    let amount: Int
    var saleId: Int?
    var saleNumber: Int?
    let createdAt: Date
}

nonisolated enum GiftCertificateOperationType: String, Codable, Sendable {
    /// Sold: + the nominal, `saleId` — the sale that sold it.
    case issue
    /// − spent in sale `saleId`.
    case redeem
    /// + given back: sale `saleId` was refunded.
    case refund
    /// − the rest burnt by the owner, or because the sale that sold it was refunded.
    case cancel
    /// − the rest burnt at `expiresAt`.
    case expire
    /// A type from a newer server.
    case unknown
}

nonisolated extension GiftCertificateOperationType {
    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = GiftCertificateOperationType(rawValue: raw) ?? .unknown
    }
}

/// Gift certificate codes: «MIKAN-XXXX-XXXX», letters and digits. Staff type, paste or dictate them in any shape.
nonisolated enum CertificateCode {
    static let prefix = "MIKAN"
    /// Characters after the prefix: two groups of four.
    static let bodyLength = 8

    /// Cyrillic letters that look like Latin ones on a printed card (a code typed on a Russian keyboard).
    private static let lookAlikes: [Character: Character] = [
        "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T",
        "Х": "X", "У": "Y",
    ]

    /// «mikan 7k3q 9f2d», «7K3Q-9F2D», «MIKAN7K3Q9F2D» → «MIKAN-7K3Q-9F2D». Anything else comes back uppercased
    /// without spaces and dashes (the server is case- and dash-insensitive); `nil` when nothing was typed.
    static func normalize(_ input: String) -> String? {
        let letters = input.uppercased().compactMap { character -> Character? in
            let latin = lookAlikes[character] ?? character
            return latin.isASCII && (latin.isLetter || latin.isNumber) ? latin : nil
        }
        guard !letters.isEmpty else { return nil }
        let compact = String(letters)
        let body = compact.hasPrefix(prefix) ? String(compact.dropFirst(prefix.count)) : compact
        guard body.count == bodyLength else { return compact }
        return "\(prefix)-\(body.prefix(4))-\(body.suffix(4))"
    }

    /// A full code that can be looked up.
    static func isComplete(_ input: String) -> Bool {
        guard let code = normalize(input) else { return false }
        return find(in: code) == code
    }

    /// The list search (`?q=` — code or recipient): a whole code typed in any shape goes in its canonical form,
    /// anything else (a name, part of a code) as typed.
    static func searchQuery(_ text: String) -> String {
        isComplete(text) ? (normalize(text) ?? text.trimmed) : text.trimmed
    }

    /// The first «MIKAN-XXXX-XXXX» in a text, e.g. the sale line «Подарочный сертификат MIKAN-7K3Q-9F2D».
    static func find(in text: String) -> String? {
        let pattern = /MIKAN-[A-Z0-9]{4}-[A-Z0-9]{4}/
        return text.uppercased().firstMatch(of: pattern).map { String($0.output) }
    }
}
