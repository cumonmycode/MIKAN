import Foundation

// MARK: - Loyalty bonuses and gift certificates (docs/API.md «Loyalty bonuses», «Gift certificates»)

extension APIClient {
    func clientBonuses(clientId: Int, limit: Int = 50, offset: Int = 0) async throws -> BonusHistoryPage {
        try await request(.get, "clients/\(clientId)/bonuses", query: queryItems([
            "limit": String(limit),
            "offset": String(offset),
        ]))
    }

    /// Adds (`amount > 0`) or takes (`amount < 0`) bonuses by hand: owner and admin.
    func adjustBonuses(clientId: Int, _ body: BonusAdjustBody) async throws -> BonusOperation {
        try await request(.post, "clients/\(clientId)/bonuses", body: body)
    }

    func certificates(
        status: GiftCertificateStatus? = nil, query: String = "", limit: Int = 50, offset: Int = 0
    ) async throws -> ItemsResponse<GiftCertificate> {
        try await request(.get, "certificates", query: queryItems([
            "status": status?.rawValue,
            "q": query.nonEmpty,
            "limit": String(limit),
            "offset": String(offset),
        ]))
    }

    /// `404` «Сертификат не найден».
    func certificate(id: Int) async throws -> GiftCertificate {
        try await request(.get, "certificates/\(id)")
    }

    /// Case- and dash-insensitive on the server; `404` «Сертификат не найден».
    func certificate(code: String) async throws -> GiftCertificate {
        try await request(.get, "certificates/code/\(code)")
    }

    /// Recipient and note (every role), expiry (owner only; `409` for an expired or cancelled certificate).
    func updateCertificate(id: Int, _ body: CertificatePatchBody) async throws -> GiftCertificate {
        try await request(.patch, "certificates/\(id)", body: body)
    }

    /// Owner only: the balance burns.
    func cancelCertificate(id: Int, reason: String) async throws -> GiftCertificate {
        try await request(.post, "certificates/\(id)/cancel", body: CertificateCancelBody(reason: reason))
    }

    /// The bot sends the certificate card to the buyer's linked Telegram chat.
    func sendCertificate(id: Int) async throws {
        try await requestVoid(.post, "certificates/\(id)/send", body: CertificateSendBody())
    }
}

/// `POST /clients/:id/bonuses`.
nonisolated struct BonusAdjustBody: Encodable, Hashable, Sendable {
    /// ≠ 0: positive adds, negative takes.
    let amount: Int
    let note: String
    /// When the added bonuses burn; omitted — never.
    var expiresAt: Date? = nil
}

nonisolated struct CertificateCancelBody: Encodable, Sendable {
    let reason: String
}

/// `POST /certificates/:id/send` with no `chatId`: the buyer's linked chat.
nonisolated struct CertificateSendBody: Encodable, Sendable {}
