import Foundation
import Observation
import os
import PhotosUI
import SwiftUI

/// What the post screen is doing right now — one action at a time (Titan's `acting`).
nonisolated enum SmmPostAction: Hashable, Sendable {
    case write, remark, image, video, upload, pick, remove, approve, skip, restore, publish, link, delete
}

/// The post with its media variants and the remarks thread, its live refresh while the marketer works and every
/// action of the post screen (Titan `post.tsx`). Each write answers with the fresh post.
@Observable
final class SmmPostModel {
    let postId: String
    let profile: SmmProfile
    let payload = Remote<SmmPostPayload>()
    /// Directions of the profile, for the header.
    private(set) var meta: SmmMeta?
    private(set) var acting: SmmPostAction?
    private(set) var isDeleted = false
    /// Bumped on every successful action (haptics).
    private(set) var successCount = 0
    var errorTitle = "Не получилось"
    var errorMessage: String?

    @ObservationIgnored private let logger = Logger(subsystem: "com.mikanstudio.crm", category: "smm")

    static let pollInterval: Duration = .seconds(3)
    /// Veo makes a clip in about two and a half minutes — the bar runs by the time since the start.
    static let videoEta: Double = 150
    /// The route takes 10–1900 characters of a video wish; shorter — the marketer decides alone.
    static let minVideoWish = 10
    static let maxRemark = 1500

    init(postId: String, profile: SmmProfile) {
        self.postId = postId
        self.profile = profile
    }

    var post: SmmPost? { payload.value?.post }

    /// The server is still on it (text, picture, revision or video): poll.
    var isWorking: Bool { post?.isWorking ?? false }

    /// The marketer writes or draws — the post is locked; a video is made aside and locks nothing.
    var isBusy: Bool {
        guard let busy = post?.busy else { return false }
        return busy != .video
    }

    /// Titan `postProgress`: the server's scale, or a pending video's by the time since it started.
    var progress: SmmProgress? {
        guard let post else { return nil }
        if let progress = post.progress { return progress }
        guard let video = post.media.first(where: { $0.isVideo && $0.isPending }) else { return nil }
        return SmmProgress(label: "Нейросеть снимает видео", pct: 2, next: 97, eta: Self.videoEta, at: video.createdAt)
    }

    // MARK: Loading

    func load(_ api: APIClient) async {
        async let loadedMeta = metaIfMissing(api)
        await payload.load { try await api.smmPost(profile, id: postId) }
        if let loaded = await loadedMeta { meta = loaded }
    }

    private func metaIfMissing(_ api: APIClient) async -> SmmMeta? {
        guard meta == nil else { return nil }
        return try? await api.smmMeta(profile)
    }

    /// Refreshes every few seconds while the server works on the post; network blips are skipped quietly.
    func pollWhileWorking(_ api: APIClient) async {
        while isWorking, !Task.isCancelled {
            try? await Task.sleep(for: Self.pollInterval)
            guard !Task.isCancelled else { return }
            await refreshQuietly(api)
        }
    }

    func refreshQuietly(_ api: APIClient) async {
        do {
            payload.set(try await api.smmPost(profile, id: postId))
        } catch is CancellationError {
            return
        } catch {
            logger.notice("SMM post refresh failed: \(error.userMessage, privacy: .public)")
        }
    }

    /// Takes a post answered by a write or saved in a sheet.
    func apply(_ post: SmmPost) {
        payload.update { current in
            var updated = current
            updated.post = post
            return updated
        }
    }

    // MARK: Actions

    @discardableResult
    func run(_ action: SmmPostAction, errorTitle: String = "Не получилось", _ job: () async throws -> SmmPost) async -> Bool {
        guard acting == nil else { return false }
        acting = action
        defer { acting = nil }
        do {
            apply(try await job())
            successCount += 1
            return true
        } catch is CancellationError {
            return false
        } catch {
            self.errorTitle = errorTitle
            errorMessage = error.userMessage
            return false
        }
    }

    func write(_ api: APIClient) async {
        await run(.write) { try await api.writeSmmPost(profile, id: postId) }
    }

    /// The marketer redoes the text, the picture or the time and answers in the thread.
    func remark(_ text: String, api: APIClient) async -> Bool {
        let value = String(text.trimmed.prefix(Self.maxRemark))
        let sent = await run(.remark, errorTitle: "Маркетолог не принял замечание") {
            try await api.remarkSmmPost(profile, id: postId, text: value)
        }
        if sent { await refreshQuietly(api) }
        return sent
    }

    /// A new picture variant of `mediaId`'s position (or a new picture), by own description or the previous one.
    func regenerate(prompt: String? = nil, mediaId: String?, api: APIClient) async {
        await run(.image, errorTitle: "Картинка не получилась") {
            try await api.regenerateSmmImage(profile, id: postId, prompt: prompt, mediaId: mediaId)
        }
    }

    func makeVideo(wish: String, api: APIClient) async {
        let value = wish.trimmed
        let prompt = value.count >= Self.minVideoWish ? value : nil
        await run(.video, errorTitle: "Видео не запустилось") {
            try await api.makeSmmVideo(profile, id: postId, prompt: prompt)
        }
    }

    func upload(_ item: PhotosPickerItem, api: APIClient) async {
        await run(.upload, errorTitle: "Файл не загрузился") {
            let file = try await SmmMediaUpload.file(from: item)
            return try await api.uploadSmmMedia(profile, postId: postId, file: file)
        }
    }

    func pick(_ media: SmmMedia, api: APIClient) async {
        guard !media.selected else { return }
        await run(.pick) { try await api.selectSmmMedia(profile, postId: postId, mediaId: media.id, selected: true) }
    }

    func remove(_ media: SmmMedia, api: APIClient) async -> Bool {
        await run(.remove, errorTitle: "Не убралось") {
            try await api.deleteSmmMedia(profile, postId: postId, mediaId: media.id)
        }
    }

    func approve(_ api: APIClient) async {
        await run(.approve) { try await api.approveSmmPost(profile, id: postId) }
    }

    func skip(_ api: APIClient) async {
        await run(.skip) { try await api.skipSmmPost(profile, id: postId) }
    }

    func restore(_ api: APIClient) async {
        await run(.restore) { try await api.restoreSmmPost(profile, id: postId) }
    }

    /// Telegram (and Instagram via the API) — out now; the rest — files and text to the publisher now.
    func publish(errorTitle: String, api: APIClient) async {
        await run(.publish, errorTitle: errorTitle) { try await api.publishSmmPost(profile, id: postId) }
    }

    func markPublished(url: String, api: APIClient) async {
        let link = url.trimmed
        guard !link.isEmpty else { return }
        await run(.link, errorTitle: "Ссылка не сохранилась") {
            try await api.markSmmPostPublished(profile, id: postId, url: link)
        }
    }

    func delete(_ api: APIClient) async {
        guard acting == nil else { return }
        acting = .delete
        defer { acting = nil }
        do {
            try await api.deleteSmmPost(profile, id: postId)
            isDeleted = true
        } catch is CancellationError {
            return
        } catch {
            errorTitle = "Не удалилось"
            errorMessage = error.userMessage
        }
    }

    // MARK: Sheets (they show their own errors)

    func saveText(_ text: String, api: APIClient) async throws {
        apply(try await api.updateSmmPost(profile, id: postId, SmmPostPatch(body: text)))
    }

    func reschedule(date: String, time: String, api: APIClient) async throws {
        apply(try await api.updateSmmPost(profile, id: postId, SmmPostPatch(date: date, time: time)))
    }
}
