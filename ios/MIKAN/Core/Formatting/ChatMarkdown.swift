import Foundation

/// The light Markdown of bot messages (API «Formatting»): `**bold**`, heading lines `# …` (1–6 `#` and a space;
/// shown bold without the hashes), list lines `- ` / `* ` (shown as `• `) and `` `code` `` (backticks dropped).
/// Everything else stays as is, line breaks included; an unpaired `**` is plain text.
nonisolated enum ChatMarkdown {
    private static let boldMarker = "**"
    private static let headingLevels = 1...6

    static func render(_ text: String) -> AttributedString {
        var result = AttributedString()
        let lines = text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
        for (index, line) in lines.enumerated() {
            if index > 0 { result.append(AttributedString("\n")) }
            result.append(renderLine(String(line.filter { $0 != "`" })))
        }
        return result
    }

    /// The text with the markers stripped: for previews and VoiceOver.
    static func plain(_ text: String) -> String {
        String(render(text).characters)
    }

    private static func renderLine(_ line: String) -> AttributedString {
        if let heading = heading(line) {
            var bold = inline(heading)
            bold.inlinePresentationIntent = .stronglyEmphasized
            return bold
        }
        if let item = listItem(line) {
            return AttributedString(item.indent + "• ") + inline(item.text)
        }
        return inline(line)
    }

    /// "## Итоги дня" → "Итоги дня"; `nil` for other lines («#тег» included).
    private static func heading(_ line: String) -> String? {
        let trimmed = line.drop { $0 == " " }
        let hashes = trimmed.prefix { $0 == "#" }
        let rest = trimmed.dropFirst(hashes.count)
        guard headingLevels.contains(hashes.count), rest.first == " " else { return nil }
        return rest.trimmingCharacters(in: .whitespaces)
    }

    /// "  - пункт" → ("  ", "пункт"); `nil` for other lines.
    private static func listItem(_ line: String) -> (indent: String, text: String)? {
        let indent = line.prefix { $0 == " " }
        let rest = line.dropFirst(indent.count)
        guard rest.hasPrefix("- ") || rest.hasPrefix("* ") else { return nil }
        return (String(indent), String(rest.dropFirst(2)))
    }

    /// `**bold**` pairs within a line; a trailing unpaired `**` stays as text.
    private static func inline(_ line: String) -> AttributedString {
        let parts = line.components(separatedBy: boldMarker)
        var result = AttributedString()
        for (index, part) in parts.enumerated() {
            let isBetweenMarkers = index % 2 == 1
            if !isBetweenMarkers {
                result.append(AttributedString(part))
            } else if index < parts.count - 1 {
                var bold = AttributedString(part)
                bold.inlinePresentationIntent = .stronglyEmphasized
                result.append(bold)
            } else {
                result.append(AttributedString(boldMarker + part))
            }
        }
        return result
    }
}

nonisolated extension BotMessage {
    private static let photoLabel = "[Фото]"

    /// The text of a bubble: the bot side's Markdown rendered, a client's text as typed. Next to a kept photo only the
    /// caption is left: the picture replaces the label.
    var displayText: AttributedString {
        guard role == .user else { return ChatMarkdown.render(text) }
        guard photoFile != nil, text.hasPrefix(Self.photoLabel) else { return AttributedString(text) }
        return AttributedString(text.dropFirst(Self.photoLabel.count).trimmingCharacters(in: .whitespaces))
    }

    /// The text with the markers stripped: for previews and VoiceOver.
    var plainText: String {
        role == .user ? text : ChatMarkdown.plain(text)
    }
}
