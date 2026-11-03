import Foundation

/// What the server accepts for a master's portfolio (docs/API.md «Portfolio»).
nonisolated enum PortfolioLimits {
    static let maxPhotos = 100
    static let maxCaptionLength = 300
    /// Photos added from one library pick.
    static let maxBatch = 20

    /// How many more photos the master may have.
    static func remaining(current count: Int) -> Int {
        max(0, maxPhotos - count)
    }

    /// How many photos the library picker may select now.
    static func pickLimit(current count: Int) -> Int {
        min(maxBatch, remaining(current: count))
    }

    /// The length that counts: the caption is sent trimmed.
    static func captionLength(_ caption: String) -> Int {
        caption.trimmed.count
    }

    static func captionMessage(_ caption: String) -> String? {
        captionLength(caption) > maxCaptionLength ? "Подпись — не длиннее \(maxCaptionLength) символов." : nil
    }
}

/// The order of a master's photos after a drag and drop or an accessibility action.
nonisolated enum PortfolioReorder {
    private static let dragPrefix = "mikan-portfolio:"

    /// The order after dropping `id` onto the tile of `target`: the dragged photo takes the target's place and the
    /// photos in between shift towards the gap. Unknown ids or a drop onto itself change nothing.
    static func moving(_ id: Int, onto target: Int, in ids: [Int]) -> [Int] {
        guard id != target, let from = ids.firstIndex(of: id), let to = ids.firstIndex(of: target) else { return ids }
        return relocating(from: from, to: to, in: ids)
    }

    /// One place earlier (`-1`) or later (`+1`), for «Переместить раньше / позже»; nothing moves past the ends.
    static func moving(_ id: Int, by offset: Int, in ids: [Int]) -> [Int] {
        guard let from = ids.firstIndex(of: id) else { return ids }
        let to = min(max(0, from + offset), ids.count - 1)
        return relocating(from: from, to: to, in: ids)
    }

    /// `PUT /portfolio/order` for a changed order; `nil` when nothing moved.
    static func orderBody(employeeId: Int, old: [Int], new: [Int]) -> PortfolioOrderBody? {
        old == new ? nil : PortfolioOrderBody(employeeId: employeeId, ids: new)
    }

    /// The photos in the order of `ids`; photos missing from `ids` keep their order after them.
    static func arranged(_ photos: [PortfolioPhoto], by ids: [Int]) -> [PortfolioPhoto] {
        let byId = Dictionary(photos.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let listed = Set(ids)
        return ids.compactMap { byId[$0] } + photos.filter { !listed.contains($0.id) }
    }

    /// The text a dragged tile carries, so a drop of unrelated text is never taken for a photo.
    static func dragPayload(for id: Int) -> String {
        dragPrefix + String(id)
    }

    static func photoId(fromDragPayload payload: String) -> Int? {
        guard payload.hasPrefix(dragPrefix) else { return nil }
        return Int(payload.dropFirst(dragPrefix.count))
    }

    private static func relocating(from: Int, to: Int, in ids: [Int]) -> [Int] {
        guard from != to else { return ids }
        let rest = ids.enumerated().filter { $0.offset != from }.map(\.element)
        return Array(rest[..<to]) + [ids[from]] + Array(rest[to...])
    }
}

/// How a portfolio photo is compressed. Clients look at it full screen, so it keeps more pixels than catalog
/// pictures: the long side up to 2048 px, JPEG; a result above 1.5 MB is encoded again down the ladder.
nonisolated enum PortfolioImageRule {
    nonisolated struct Attempt: Hashable, Sendable {
        let maxPixelSize: Int
        let quality: Double
    }

    nonisolated struct PixelSize: Hashable, Sendable {
        let width: Int
        let height: Int
    }

    static let maxPixelSize = 2048
    /// 1.5 MB.
    static let maxByteCount = 1_500_000

    static let firstAttempt = Attempt(maxPixelSize: maxPixelSize, quality: 0.82)
    /// Tried in order while the result is too big; the last one is kept whatever its size.
    static let ladder: [Attempt] = [
        firstAttempt,
        Attempt(maxPixelSize: maxPixelSize, quality: 0.7),
        Attempt(maxPixelSize: 1600, quality: 0.7),
        Attempt(maxPixelSize: 1280, quality: 0.65),
    ]

    static func accepts(byteCount: Int) -> Bool {
        byteCount <= maxByteCount
    }

    /// The attempt after `attempt`; `nil` after the last one (or for an attempt not on the ladder).
    static func nextAttempt(after attempt: Attempt) -> Attempt? {
        guard let index = ladder.firstIndex(of: attempt), index + 1 < ladder.count else { return nil }
        return ladder[index + 1]
    }

    /// The pixel size with the long side fitted into `maxPixelSize`: aspect ratio kept, rounded, never upscaled,
    /// at least 1 px each way.
    static func scaledSize(width: Int, height: Int, maxPixelSize: Int = maxPixelSize) -> PixelSize {
        let longSide = max(width, height)
        guard longSide > maxPixelSize, maxPixelSize > 0 else {
            return PixelSize(width: max(1, width), height: max(1, height))
        }
        let scale = Double(maxPixelSize) / Double(longSide)
        return PixelSize(
            width: max(1, Int((Double(width) * scale).rounded())),
            height: max(1, Int((Double(height) * scale).rounded()))
        )
    }
}

/// Encodes a picked photo for the portfolio off the main actor, walking `PortfolioImageRule.ladder`.
nonisolated enum PortfolioImagePreparer {
    @concurrent
    static func prepare(_ data: Data) async throws -> Data {
        try encode(data, attempt: PortfolioImageRule.firstAttempt)
    }

    private static func encode(_ data: Data, attempt: PortfolioImageRule.Attempt) throws -> Data {
        try Task.checkCancellation()
        let jpeg = try ImagePreparer.jpeg(from: data, maxPixelSize: attempt.maxPixelSize, quality: attempt.quality)
        guard !PortfolioImageRule.accepts(byteCount: jpeg.count),
              let next = PortfolioImageRule.nextAttempt(after: attempt) else { return jpeg }
        return try encode(data, attempt: next)
    }
}

/// What a photo can be tied to in the editor.
nonisolated enum PortfolioServices {
    /// The active services, plus the photo's own service when it is hidden now (so the picker can show it).
    static func options(active: [ServiceRef], current: ServiceRef?) -> [ServiceRef] {
        guard let current, !active.contains(where: { $0.id == current.id }) else { return active }
        return active + [current]
    }
}

/// Texts of the portfolio screen.
nonisolated enum PortfolioText {
    static let deleteWarning = "Фото пропадёт из портфолио мастера и из онлайн-записи."

    /// «Фото 3 из 12. Хеликс, титан. Услуга: Хеликс».
    static func accessibilityLabel(_ photo: PortfolioPhoto, index: Int, count: Int) -> String {
        let parts: [String?] = ["Фото \(index + 1) из \(count)", photo.caption.nonEmpty, photo.service.map { "Услуга: \($0.name)" }]
        return parts.compactMap(\.self).joined(separator: ". ")
    }

    /// Partial failures of a batch upload: what made it stays.
    static func uploadFailure(failures: Int, total: Int, lastError: String?) -> String {
        let reason = lastError ?? "Попробуйте ещё раз."
        guard total > 1 else { return reason }
        return "Не удалось добавить \(failures) из \(total) фото. \(reason)"
    }
}
