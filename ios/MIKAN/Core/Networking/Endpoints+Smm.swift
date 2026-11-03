import Foundation

// MARK: - «СММ-маркетолог»: `/smm/profiles` and `/smm/:profile/…` (docs/SMM.md)
//
// Long work (plan, post, revision, picture, video, studying) runs on the server in the background: the answer comes
// at once with `busy` / `progress` set, and screens poll until they clear. Ideas, reports and stats collection are
// awaited, so they get a longer timeout.

extension APIClient {
    /// AI answers awaited in the request (ideas, report), a stats sweep over the platforms: the server may retry the
    /// model once (2 × 180 s).
    static let smmLongTimeout: TimeInterval = 400
    /// «Опубликовать»: the server answers after the post is out — Instagram waits for its containers (up to 5 min per
    /// video), Telegram uploads the files.
    static let smmPublishTimeout: TimeInterval = 600

    private func smm(_ profile: SmmProfile, _ path: String) -> String {
        "smm/\(profile.rawValue)/\(path)"
    }

    // MARK: Profiles, meta, overview

    /// Both profiles for the switcher and the badges.
    func smmProfiles() async throws -> [SmmProfileSummary] {
        let response: ItemsResponse<SmmProfileSummary> = try await request(.get, "smm/profiles")
        return response.items
    }

    func smmMeta(_ profile: SmmProfile) async throws -> SmmMeta {
        try await request(.get, smm(profile, "meta"))
    }

    func smmOverview(_ profile: SmmProfile) async throws -> SmmOverview {
        try await request(.get, smm(profile, "overview"))
    }

    /// Employees to pick approvers and the publisher from.
    func smmPeople(_ profile: SmmProfile) async throws -> [SmmPerson] {
        let response: ItemsResponse<SmmPerson> = try await request(.get, smm(profile, "people"))
        return response.items
    }

    // MARK: Posts

    func smmPosts(_ profile: SmmProfile, from: Date? = nil, to: Date? = nil) async throws -> [SmmPost] {
        let response: SmmPostsResponse = try await request(.get, smm(profile, "posts"), query: queryItems([
            "from": from.map(ISO8601.string(from:)),
            "to": to.map(ISO8601.string(from:)),
        ]))
        return response.posts
    }

    /// Swaps the publication times of two posts (the order in the plan).
    func swapSmmPosts(_ profile: SmmProfile, _ first: String, _ second: String) async throws {
        try await requestVoid(.post, smm(profile, "posts/swap"), body: SmmSwapBody(a: first, b: second))
    }

    func createSmmPost(_ profile: SmmProfile, _ body: SmmNewPostBody) async throws -> SmmPost {
        let response: SmmPostResponse = try await request(.post, smm(profile, "posts"), body: body)
        return response.post
    }

    /// The post with all media variants, the remarks thread and whether you may approve.
    func smmPost(_ profile: SmmProfile, id: String) async throws -> SmmPostPayload {
        try await request(.get, smm(profile, "posts/\(id)"))
    }

    func updateSmmPost(_ profile: SmmProfile, id: String, _ patch: SmmPostPatch) async throws -> SmmPost {
        try await postWrite(profile, .patch, "posts/\(id)", body: patch)
    }

    /// A published post is not deleted (analytics needs it).
    func deleteSmmPost(_ profile: SmmProfile, id: String) async throws {
        try await requestVoid(.delete, smm(profile, "posts/\(id)"))
    }

    /// The marketer writes (or rewrites from scratch) the text and the visual.
    func writeSmmPost(_ profile: SmmProfile, id: String) async throws -> SmmPost {
        try await postWrite(profile, .post, "posts/\(id)/write")
    }

    /// A remark: the marketer revises the post and answers in the thread.
    func remarkSmmPost(_ profile: SmmProfile, id: String, text: String) async throws -> SmmPost {
        try await postWrite(profile, .post, "posts/\(id)/remark", body: TextBody(text: text))
    }

    /// A new picture variant: by own description, or redraws `mediaId`'s position.
    func regenerateSmmImage(_ profile: SmmProfile, id: String, prompt: String? = nil, mediaId: String? = nil) async throws -> SmmPost {
        try await postWrite(profile, .post, "posts/\(id)/image", body: SmmImageBody(prompt: prompt.nonEmpty, mediaId: mediaId))
    }

    /// A neural network video (ready in a few minutes; the media stays `pending` until then).
    func makeSmmVideo(_ profile: SmmProfile, id: String, prompt: String? = nil) async throws -> SmmPost {
        try await postWrite(profile, .post, "posts/\(id)/video", body: SmmVideoBody(prompt: prompt.nonEmpty))
    }

    /// Own photo or video from the phone (a shot reel, for example).
    func uploadSmmMedia(_ profile: SmmProfile, postId: String, file: SmmUpload) async throws -> SmmPost {
        let timeout = file.mimeType.hasPrefix("video/") ? Self.videoUploadTimeout : Self.uploadTimeout
        let response: SmmPostResponse = try await upload(
            smm(profile, "posts/\(postId)/media"),
            data: file.data, filename: file.filename, mimeType: file.mimeType, timeout: timeout
        )
        return response.post
    }

    /// Picks the variant of its position (or takes it out of the post).
    func selectSmmMedia(_ profile: SmmProfile, postId: String, mediaId: String, selected: Bool) async throws -> SmmPost {
        try await postWrite(profile, .patch, "posts/\(postId)/media/\(mediaId)", body: SmmSelectBody(selected: selected))
    }

    /// Removes the position with all its variants.
    func deleteSmmMedia(_ profile: SmmProfile, postId: String, mediaId: String) async throws -> SmmPost {
        try await postWrite(profile, .delete, "posts/\(postId)/media/\(mediaId)")
    }

    /// Carousel slides / story frames order: the former `sort` numbers in the new order.
    func reorderSmmMedia(_ profile: SmmProfile, postId: String, sorts: [Int]) async throws -> SmmPost {
        try await postWrite(profile, .post, "posts/\(postId)/media/order", body: SmmOrderBody(sorts: sorts))
    }

    /// An archive photo goes into the post as is (cropped to the format).
    func addSmmArchivePhoto(_ profile: SmmProfile, postId: String, photoId: String) async throws -> SmmPost {
        try await postWrite(profile, .post, "posts/\(postId)/media/archive", body: SmmArchivePhotoBody(photoId: photoId))
    }

    func approveSmmPost(_ profile: SmmProfile, id: String) async throws -> SmmPost {
        try await postWrite(profile, .post, "posts/\(id)/approve")
    }

    /// «Не выкладывать».
    func skipSmmPost(_ profile: SmmProfile, id: String) async throws -> SmmPost {
        try await postWrite(profile, .post, "posts/\(id)/skip")
    }

    func restoreSmmPost(_ profile: SmmProfile, id: String) async throws -> SmmPost {
        try await postWrite(profile, .post, "posts/\(id)/restore")
    }

    /// Now: Telegram — to the channel; Instagram, stories, reels — files and text to the publisher.
    func publishSmmPost(_ profile: SmmProfile, id: String) async throws -> SmmPost {
        try await postWrite(profile, .post, "posts/\(id)/publish", timeout: Self.smmPublishTimeout)
    }

    /// The link to the post published by hand: marks it published.
    func markSmmPostPublished(_ profile: SmmProfile, id: String, url: String) async throws -> SmmPost {
        try await postWrite(profile, .post, "posts/\(id)/link", body: SmmLinkBody(url: url))
    }

    private func postWrite(
        _ profile: SmmProfile,
        _ method: HTTPMethod,
        _ path: String,
        body: (any Encodable)? = nil,
        timeout: TimeInterval = APIClient.requestTimeout
    ) async throws -> SmmPost {
        let response: SmmPostResponse = try await request(method, smm(profile, path), body: body, timeout: timeout)
        return response.post
    }

    // MARK: Monthly plan (`month` — `YYYY-MM`)

    func smmPlan(_ profile: SmmProfile, month: String) async throws -> SmmPlanPayload {
        try await request(.get, smm(profile, "plans/\(month)"))
    }

    /// The marketer drafts the plan in the background (about a minute).
    func generateSmmPlan(_ profile: SmmProfile, month: String, wishes: String? = nil) async throws -> SmmPlanPayload {
        try await request(.post, smm(profile, "plans/\(month)/generate"), body: SmmWishesBody(wishes: wishes.nonEmpty))
    }

    func approveSmmPlan(_ profile: SmmProfile, month: String) async throws -> SmmPlanPayload {
        try await request(.post, smm(profile, "plans/\(month)/approve"))
    }

    func remarkSmmPlan(_ profile: SmmProfile, month: String, text: String) async throws -> SmmPlanPayload {
        try await request(.post, smm(profile, "plans/\(month)/remark"), body: TextBody(text: text))
    }

    // MARK: Ideas and memory

    func smmIdeas(_ profile: SmmProfile, _ body: SmmIdeasBody) async throws -> [SmmIdea] {
        let response: SmmIdeasResponse = try await request(.post, smm(profile, "ideas"), body: body, timeout: Self.smmLongTimeout)
        return response.ideas
    }

    func smmMemory(_ profile: SmmProfile) async throws -> [SmmMemory] {
        let response: SmmMemoryResponse = try await request(.get, smm(profile, "memory"))
        return response.memory
    }

    /// Returns the whole memory after the change.
    func addSmmMemory(_ profile: SmmProfile, kind: SmmMemoryKind, text: String) async throws -> [SmmMemory] {
        let response: SmmMemoryResponse = try await request(
            .post, smm(profile, "memory"), body: SmmMemoryBody(kind: kind, text: text)
        )
        return response.memory
    }

    func deleteSmmMemory(_ profile: SmmProfile, id: String) async throws -> [SmmMemory] {
        let response: SmmMemoryResponse = try await request(.delete, smm(profile, "memory/\(id)"))
        return response.memory
    }

    // MARK: Analytics and reports

    func smmAnalytics(_ profile: SmmProfile) async throws -> SmmAnalytics {
        try await request(.get, smm(profile, "analytics"))
    }

    /// Collects the platforms' numbers now and answers with fresh analytics.
    func collectSmmStats(_ profile: SmmProfile) async throws -> SmmAnalytics {
        try await request(.post, smm(profile, "analytics/collect"), timeout: Self.smmLongTimeout)
    }

    /// `from` / `to` — `YYYY-MM-DD`, both or neither (the last period).
    func generateSmmReport(_ profile: SmmProfile, from: String? = nil, to: String? = nil) async throws -> SmmReport {
        let response: SmmReportResponse = try await request(
            .post, smm(profile, "reports/generate"), body: SmmReportBody(from: from, to: to), timeout: Self.smmLongTimeout
        )
        return response.report
    }

    func smmReport(_ profile: SmmProfile, id: String) async throws -> SmmReport {
        let response: SmmReportResponse = try await request(.get, smm(profile, "reports/\(id)"))
        return response.report
    }

    // MARK: Settings and platform accounts

    func smmSettings(_ profile: SmmProfile) async throws -> SmmSettingsPayload {
        try await request(.get, smm(profile, "settings"))
    }

    func saveSmmSettings(_ profile: SmmProfile, _ patch: SmmSettingsPatch) async throws -> SmmSettingsPayload {
        try await request(.put, smm(profile, "settings"), body: patch)
    }

    /// Telegram is checked right away (the bot must be the channel's admin), then the numbers are collected.
    func addSmmAccount(_ profile: SmmProfile, _ body: SmmAccountBody) async throws -> SmmSettingsPayload {
        try await request(.post, smm(profile, "accounts"), body: body, timeout: Self.smmLongTimeout)
    }

    func updateSmmAccount(_ profile: SmmProfile, id: String, _ patch: SmmAccountPatch) async throws -> SmmSettingsPayload {
        try await request(.patch, smm(profile, "accounts/\(id)"), body: patch)
    }

    /// Rechecks the channel (the bot became an admin — it can post).
    func checkSmmAccount(_ profile: SmmProfile, id: String) async throws -> SmmSettingsPayload {
        try await request(.post, smm(profile, "accounts/\(id)/check"), timeout: Self.smmLongTimeout)
    }

    func deleteSmmAccount(_ profile: SmmProfile, id: String) async throws -> SmmSettingsPayload {
        try await request(.delete, smm(profile, "accounts/\(id)"))
    }

    // MARK: Instagram API

    func smmInstagram(_ profile: SmmProfile) async throws -> SmmInstagram {
        try await request(.get, smm(profile, "instagram"))
    }

    /// Connects with a token from the Meta dashboard.
    func connectSmmInstagram(_ profile: SmmProfile, token: String) async throws -> SmmInstagram {
        try await request(.put, smm(profile, "instagram"), body: SmmTokenBody(token: token), timeout: Self.smmLongTimeout)
    }

    func disconnectSmmInstagram(_ profile: SmmProfile) async throws -> SmmInstagram {
        try await request(.delete, smm(profile, "instagram"))
    }

    // MARK: Photo archive (Google Drive)

    func smmLibrary(_ profile: SmmProfile) async throws -> SmmLibrary {
        try await request(.get, smm(profile, "library"))
    }

    func connectSmmLibrary(_ profile: SmmProfile, link: String) async throws -> SmmLibrary {
        try await request(.put, smm(profile, "library"), body: SmmLibraryLinkBody(link: link), timeout: Self.smmLongTimeout)
    }

    func disconnectSmmLibrary(_ profile: SmmProfile) async throws -> SmmLibrary {
        try await request(.delete, smm(profile, "library"))
    }

    /// Rereads the archive in the background (`state.progress`).
    func syncSmmLibrary(_ profile: SmmProfile) async throws -> SmmLibrary {
        try await request(.post, smm(profile, "library/sync"))
    }

    func smmAlbumPhotos(_ profile: SmmProfile, albumId: String) async throws -> [SmmLibraryPhoto] {
        let response: SmmPhotosResponse = try await request(.get, smm(profile, "library/albums/\(albumId)"))
        return response.photos
    }

    /// Search by the descriptions (at least 2 characters, otherwise empty).
    func searchSmmLibrary(_ profile: SmmProfile, query: String) async throws -> [SmmLibraryPhoto] {
        let response: SmmPhotosResponse = try await request(
            .get, smm(profile, "library/search"), query: queryItems(["q": query.trimmed])
        )
        return response.photos
    }

    // MARK: Knowledge base

    func smmKnowledge(_ profile: SmmProfile) async throws -> SmmKnowledge {
        try await request(.get, smm(profile, "knowledge"))
    }

    /// Staff's words about the brand — the main source of the portrait.
    func saveSmmBrandText(_ profile: SmmProfile, ownerText: String) async throws -> SmmKnowledge {
        try await request(.put, smm(profile, "knowledge/brand"), body: SmmOwnerTextBody(ownerText: ownerText.trimmed))
    }

    /// The marketer recomposes the portrait or studies the socials again (in the background).
    func refreshSmmKnowledge(_ profile: SmmProfile, key: SmmKnowledgeKey) async throws -> SmmKnowledge {
        try await request(.post, smm(profile, "knowledge/\(key.rawValue)/refresh"))
    }

    func addSmmZone(_ profile: SmmProfile, title: String) async throws -> SmmKnowledge {
        try await request(.post, smm(profile, "zones"), body: SmmZoneBody(title: title.trimmed))
    }

    func updateSmmZone(_ profile: SmmProfile, id: String, _ body: SmmZoneBody) async throws -> SmmKnowledge {
        try await request(.patch, smm(profile, "zones/\(id)"), body: body)
    }

    func deleteSmmZone(_ profile: SmmProfile, id: String) async throws -> SmmKnowledge {
        try await request(.delete, smm(profile, "zones/\(id)"))
    }

    /// One photo per request (a JPEG prepared with `ImagePreparer`).
    func uploadSmmZonePhoto(_ profile: SmmProfile, zoneId: String, jpegData: Data) async throws -> SmmKnowledge {
        let file = SmmUpload.photo(jpegData: jpegData)
        return try await upload(
            smm(profile, "zones/\(zoneId)/photos"), data: file.data, filename: file.filename, mimeType: file.mimeType
        )
    }

    func deleteSmmZonePhoto(_ profile: SmmProfile, zoneId: String, photoId: String) async throws -> SmmKnowledge {
        try await request(.delete, smm(profile, "zones/\(zoneId)/photos/\(photoId)"))
    }

    /// The marketer looks at the zone's photos and writes its description (in the background).
    func describeSmmZone(_ profile: SmmProfile, zoneId: String) async throws -> SmmKnowledge {
        try await request(.post, smm(profile, "zones/\(zoneId)/describe"))
    }

    /// `day` — `YYYY-MM-DD` once or `MM-DD` every year.
    func addSmmDate(_ profile: SmmProfile, day: String, title: String, note: String? = nil) async throws -> SmmKnowledge {
        try await request(.post, smm(profile, "dates"), body: SmmDateBody(day: day, title: title.trimmed, note: note.nonEmpty))
    }

    func deleteSmmDate(_ profile: SmmProfile, id: String) async throws -> SmmKnowledge {
        try await request(.delete, smm(profile, "dates/\(id)"))
    }
}
