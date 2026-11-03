import Foundation

// Request bodies of `/smm/:profile/…`. `nil` optionals are omitted; `Nullable` sends an explicit `null` to clear.

nonisolated struct SmmNewPostBody: Encodable, Sendable {
    var platform: SmmPlatform
    var format: SmmFormat
    /// `YYYY-MM-DD` in the studio time zone.
    var date: String
    /// `HH:mm` in the studio time zone.
    var time: String
    var topic: String
    var brief: String?
    var direction: String?
    /// The marketer writes the text and draws right away.
    var write: Bool?
}

/// Manual edit of a post; only the fields set are changed.
nonisolated struct SmmPostPatch: Encodable, Sendable {
    var topic: String?
    var brief: String?
    var body: String?
    /// `YYYY-MM-DD` in the studio time zone.
    var date: String?
    /// `HH:mm` in the studio time zone.
    var time: String?
    var platform: SmmPlatform?
    var format: SmmFormat?
    var direction: Nullable<String>?
    var assigneeId: Nullable<Int>?
    var script: Nullable<SmmScript>?
}

nonisolated struct SmmImageBody: Encodable, Sendable {
    /// Own description of the picture; omitted — the previous one.
    var prompt: String?
    /// The variant to redraw (its position).
    var mediaId: String?
}

nonisolated struct SmmVideoBody: Encodable, Sendable {
    /// Own wish for the scene (10–1900 characters); omitted — the marketer decides.
    var prompt: String?
}

nonisolated struct SmmSelectBody: Encodable, Sendable {
    let selected: Bool
}

/// Former `sort` numbers of the positions, in the new order.
nonisolated struct SmmOrderBody: Encodable, Sendable {
    let sorts: [Int]
}

nonisolated struct SmmArchivePhotoBody: Encodable, Sendable {
    let photoId: String
}

nonisolated struct SmmLinkBody: Encodable, Sendable {
    /// `https://…` of the published post.
    let url: String
}

nonisolated struct SmmSwapBody: Encodable, Sendable {
    let a: String
    let b: String
}

nonisolated struct SmmWishesBody: Encodable, Sendable {
    var wishes: String?
}

nonisolated struct SmmIdeasBody: Encodable, Sendable {
    var direction: String?
    var platform: SmmPlatform?
    var format: SmmFormat?
    var wish: String?
}

nonisolated struct SmmMemoryBody: Encodable, Sendable {
    let kind: SmmMemoryKind
    let text: String
}

/// Both `YYYY-MM-DD` or both omitted (the last period).
nonisolated struct SmmReportBody: Encodable, Sendable {
    var from: String?
    var to: String?
}

nonisolated struct SmmCadencePatch: Encodable, Hashable, Sendable {
    var telegram: Int?
    var instagram: Int?
    var stories: Int?
    var reels: Int?
}

/// Settings change; only the fields set are saved.
nonisolated struct SmmSettingsPatch: Encodable, Sendable {
    var enabled: Bool?
    var brandName: String?
    var autopilot: Bool?
    var voice: String?
    var audience: String?
    var goals: String?
    var directions: String?
    var cadence: SmmCadencePatch?
    var postTime: String?
    var approverIds: [Int]?
    /// `Nullable(nil)` — the first approver posts.
    var publisherId: Nullable<Int>?
    var reviewLeadHours: Int?
    var monthlyBudget: Int?
}

nonisolated struct SmmAccountBody: Encodable, Sendable {
    let platform: SmmAccountPlatform
    /// Telegram: `@channel`, `t.me/…` or `-100…`; others: a profile link or `@name`.
    let input: String
    var title: String?
}

nonisolated struct SmmAccountPatch: Encodable, Sendable {
    var isActive: Bool?
    var title: String?
}

nonisolated struct SmmTokenBody: Encodable, Sendable {
    let token: String
}

nonisolated struct SmmLibraryLinkBody: Encodable, Sendable {
    /// A Google Drive folder link.
    let link: String
}

nonisolated struct SmmOwnerTextBody: Encodable, Sendable {
    let ownerText: String
}

nonisolated struct SmmZoneBody: Encodable, Sendable {
    var title: String?
    var ownerText: String?
}

nonisolated struct SmmDateBody: Encodable, Sendable {
    /// `YYYY-MM-DD` once or `MM-DD` every year.
    let day: String
    let title: String
    var note: String?
}

/// A file for `multipart/form-data` (field `file`): photos up to 10 MB, videos up to 100 MB.
nonisolated struct SmmUpload: Sendable {
    let data: Data
    let filename: String
    let mimeType: String

    static func photo(jpegData: Data) -> SmmUpload {
        SmmUpload(data: jpegData, filename: "photo.jpg", mimeType: "image/jpeg")
    }

    /// `fileExtension` — `mp4` or `mov`.
    static func video(data: Data, fileExtension: String = "mp4") -> SmmUpload {
        let ext = fileExtension.lowercased()
        let mime = ext == "mov" ? "video/quicktime" : "video/\(ext)"
        return SmmUpload(data: data, filename: "video.\(ext)", mimeType: mime)
    }
}
