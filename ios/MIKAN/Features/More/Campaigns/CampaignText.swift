import Foundation

/// The text of a campaign or greeting (docs/API.md «Campaigns»): the `{name}` placeholder and Telegram's limits —
/// 3 500 characters for a text message, 1 024 for a photo caption. Lengths are counted like the server counts them
/// (JavaScript string length: UTF-16 code units, so an emoji takes two) on the trimmed text.
nonisolated enum CampaignText {
    static let nameToken = "{name}"
    static let maxLength = 3_500
    static let maxCaptionLength = 1_024
    static let maxTitleLength = 200
    /// Shown in the preview until the server names a real recipient.
    static let sampleName = "Анна"

    static func limit(hasImage: Bool) -> Int {
        hasImage ? maxCaptionLength : maxLength
    }

    static func length(_ text: String) -> Int {
        text.trimmed.utf16.count
    }

    /// «1 230 / 3 500».
    static func counter(_ text: String, hasImage: Bool) -> String {
        "\(group(length(text))) / \(group(limit(hasImage: hasImage)))"
    }

    static func isTooLong(_ text: String, hasImage: Bool) -> Bool {
        length(text) > limit(hasImage: hasImage)
    }

    /// Why the text can't be sent, or `nil`.
    static func issue(_ text: String, hasImage: Bool) -> String? {
        if text.trimmed.isEmpty { return "Напишите текст сообщения." }
        guard isTooLong(text, hasImage: hasImage) else { return nil }
        let over = group(length(text) - limit(hasImage: hasImage))
        return hasImage
            ? "С картинкой Telegram отправляет не больше \(group(maxCaptionLength)) символов — сократите текст на \(over) или уберите картинку."
            : "Сообщение — не длиннее \(group(maxLength)) символов, сократите на \(over)."
    }

    /// What the client sees: every `{name}` replaced with their first name.
    static func personalized(_ text: String, name: String) -> String {
        text.replacingOccurrences(of: nameToken, with: name)
    }

    /// The first name used in the preview: the first word of the sample client's `name` (older cards keep the full
    /// name there), else `sampleName`.
    static func previewName(_ client: ClientRef?) -> String {
        guard let client else { return sampleName }
        let first = PersonName.split(client.name).first
        return first.isEmpty ? sampleName : first
    }

    /// Puts `token` in place of `selection` (the cursor or a selected range; `nil` — at the end).
    /// Returns the new text and the character offset right after the token, for the new cursor.
    static func inserting(_ token: String, into text: String, replacing selection: Range<String.Index>?) -> (text: String, cursorOffset: Int) {
        guard let selection, selection.lowerBound >= text.startIndex, selection.upperBound <= text.endIndex else {
            return (text + token, text.count + token.count)
        }
        let start = text.distance(from: text.startIndex, to: selection.lowerBound)
        let result = String(text[..<selection.lowerBound]) + token + String(text[selection.upperBound...])
        return (result, start + token.count)
    }

    private static func group(_ number: Int) -> String {
        Money.group(UInt(max(0, number)))
    }
}
