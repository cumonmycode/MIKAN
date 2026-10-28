import Foundation

// MARK: - Campaigns, retention settings, the client's news opt-out

/// `POST /campaigns`, `PATCH /campaigns/:id`. `null` clears the picture or the button on PATCH.
nonisolated struct CampaignBody: Encodable, Hashable, Sendable {
    var title: String
    var text: String
    var imageUrl: Nullable<String>
    var button: Nullable<CampaignButton>
    var segment: CampaignSegment
}

nonisolated struct CampaignPreviewBody: Encodable, Sendable {
    let segment: CampaignSegment
}

/// `POST /campaigns/:id/send`: `at` omitted — now.
nonisolated struct CampaignSendBody: Encodable, Sendable {
    var at: Date?
}

/// `PATCH /clients/:id` with only the news opt-out.
nonisolated struct MarketingOptOutBody: Encodable, Sendable {
    let marketingOptOut: Bool
}

nonisolated struct SentResponse: Decodable, Sendable {
    let sent: Bool
}

extension APIClient {
    /// Newest first.
    func campaigns() async throws -> [Campaign] {
        let response: ItemsResponse<Campaign> = try await request(.get, "campaigns")
        return response.items
    }

    func createCampaign(_ body: CampaignBody) async throws -> Campaign {
        try await request(.post, "campaigns", body: body)
    }

    func updateCampaign(id: Int, _ body: CampaignBody) async throws -> Campaign {
        try await request(.patch, "campaigns/\(id)", body: body)
    }

    /// How many clients the segment reaches now, with up to five of them.
    func campaignAudience(_ segment: CampaignSegment) async throws -> CampaignAudience {
        try await request(.post, "campaigns/preview", body: CampaignPreviewBody(segment: segment))
    }

    /// Sends the message to the signed-in employee's staff chat (or the staff group).
    func testCampaign(id: Int) async throws {
        let _: SentResponse = try await request(.post, "campaigns/\(id)/test")
    }

    /// `at` — schedule; `nil` — start sending now.
    func sendCampaign(id: Int, at: Date? = nil) async throws -> Campaign {
        try await request(.post, "campaigns/\(id)/send", body: CampaignSendBody(at: at))
    }

    func cancelCampaign(id: Int) async throws -> Campaign {
        try await request(.post, "campaigns/\(id)/cancel")
    }

    /// Drafts only.
    func deleteCampaign(id: Int) async throws {
        try await requestVoid(.delete, "campaigns/\(id)")
    }

    func retentionSettings() async throws -> RetentionSettings {
        try await request(.get, "settings/retention")
    }

    func saveRetentionSettings(_ settings: RetentionSettings) async throws -> RetentionSettings {
        try await request(.put, "settings/retention", body: settings)
    }

    /// «Получать новости и акции» on the client card (inverted).
    func setClientMarketingOptOut(id: Int, optOut: Bool) async throws -> Client {
        try await request(.patch, "clients/\(id)", body: MarketingOptOutBody(marketingOptOut: optOut))
    }
}
