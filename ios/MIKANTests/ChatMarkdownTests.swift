import Foundation
import Testing
@testable import MIKAN

/// The light Markdown of bot messages: bold, headings, list lines, backticks; everything else as is.
struct ChatMarkdownTests {
    private func text(_ rendered: AttributedString) -> String {
        String(rendered.characters)
    }

    private func boldParts(_ rendered: AttributedString) -> [String] {
        rendered.runs.compactMap { run in
            run.inlinePresentationIntent == .stronglyEmphasized ? String(rendered[run.range].characters) : nil
        }
    }

    private func message(_ role: MessageRole, _ text: String) -> BotMessage {
        BotMessage(id: 1, chatId: 1, role: role, text: text, employee: nil, createdAt: .distantPast)
    }

    private func photoMessage(_ text: String) -> BotMessage {
        BotMessage(id: 1, chatId: 1, role: .user, text: text, employee: nil, createdAt: .distantPast, photoFile: "a.jpg")
    }

    @Test("A kept photo replaces the label in the bubble, the caption stays")
    func photoCaption() {
        #expect(text(photoMessage("[Фото] он прям будто впивается").displayText) == "он прям будто впивается")
        #expect(text(photoMessage("[Фото]").displayText).isEmpty)
    }

    @Test("Without a kept photo the label stays; previews and VoiceOver always have it")
    func photoLabel() {
        #expect(text(message(.user, "[Фото] заживает?").displayText) == "[Фото] заживает?")
        #expect(photoMessage("[Фото] заживает?").plainText == "[Фото] заживает?")
    }

    @Test("Plain text stays as is")
    func plainText() {
        let rendered = ChatMarkdown.render("Здравствуйте! Прокол хеликса — 3 000 ₽ 😊")
        #expect(text(rendered) == "Здравствуйте! Прокол хеликса — 3 000 ₽ 😊")
        #expect(boldParts(rendered).isEmpty)
    }

    @Test("Paired ** become bold without the markers")
    func bold() {
        let rendered = ChatMarkdown.render("**Хеликс** — **3 000 ₽**, украшение отдельно")
        #expect(text(rendered) == "Хеликс — 3 000 ₽, украшение отдельно")
        #expect(boldParts(rendered) == ["Хеликс", "3 000 ₽"])
    }

    /// Source, rendered text, bold parts.
    static let unpaired: [(String, String, [String])] = [
        ("цена **3 000 ₽", "цена **3 000 ₽", []),
        ("**а** и **б", "а и **б", ["а"]),
        ("2**3", "2**3", []),
        ("**", "**", []),
        ("***", "***", []),
        ("****", "", []),
    ]

    @Test("An unpaired ** stays as plain text", arguments: unpaired)
    func unpairedBold(source: String, expected: String, bold: [String]) {
        let rendered = ChatMarkdown.render(source)
        #expect(text(rendered) == expected)
        #expect(boldParts(rendered) == bold)
    }

    @Test("Bold never spans lines")
    func boldPerLine() {
        let rendered = ChatMarkdown.render("**начало\nконец**")
        #expect(text(rendered) == "**начало\nконец**")
        #expect(boldParts(rendered).isEmpty)
    }

    @Test("Heading lines are bold without the hashes")
    func headings() {
        let rendered = ChatMarkdown.render("# Итоги дня\nВыручка 12 000 ₽\n### **Завтра**")
        #expect(text(rendered) == "Итоги дня\nВыручка 12 000 ₽\nЗавтра")
        #expect(boldParts(rendered) == ["Итоги дня", "Завтра"])
    }

    @Test("Hashes without a space or more than six are not headings", arguments: ["#тату", "####### семь", "#", "Цена #1"])
    func notHeadings(source: String) {
        let rendered = ChatMarkdown.render(source)
        #expect(text(rendered) == source)
        #expect(boldParts(rendered).isEmpty)
    }

    @Test("List lines start with a bullet, indentation kept")
    func lists() {
        let rendered = ChatMarkdown.render("- один\n* **два**\n  - вложенный\n-1 °C\n*звёздочка*")
        #expect(text(rendered) == "• один\n• два\n  • вложенный\n-1 °C\n*звёздочка*")
        #expect(boldParts(rendered) == ["два"])
    }

    @Test("Backticks are dropped")
    func code() {
        #expect(ChatMarkdown.plain("Код записи: `A-12`") == "Код записи: A-12")
        #expect(ChatMarkdown.plain("```\nтекст\n```") == "\nтекст\n")
    }

    @Test("Line breaks and blank lines are kept")
    func lineBreaks() {
        #expect(ChatMarkdown.plain("Привет!\n\nЗапись **завтра**.\n") == "Привет!\n\nЗапись завтра.\n")
        #expect(ChatMarkdown.plain("a\r\nb") == "a\nb")
        #expect(ChatMarkdown.plain("") == "")
    }

    @Test("A staff summary renders as expected")
    func staffSummary() {
        let source = "☀️ **Доброе утро, Анна!**\n\n## Сегодня\n- 11:00 Иван — Хеликс (вы)\n- 15:00 Мария — Лабрет\n\n**Обратить внимание:** нет"
        #expect(ChatMarkdown.plain(source) == "☀️ Доброе утро, Анна!\n\nСегодня\n• 11:00 Иван — Хеликс (вы)\n• 15:00 Мария — Лабрет\n\nОбратить внимание: нет")
    }

    @Test("Bot-side messages render the Markdown, a client's text stays as typed")
    func messages() {
        let assistant = message(.assistant, "**Да**, есть")
        #expect(text(assistant.displayText) == "Да, есть")
        #expect(boldParts(assistant.displayText) == ["Да"])
        #expect(assistant.plainText == "Да, есть")
        #expect(message(.system, "- памятка").plainText == "• памятка")

        let client = message(.user, "**срочно** - перезвоните")
        #expect(text(client.displayText) == "**срочно** - перезвоните")
        #expect(client.plainText == "**срочно** - перезвоните")
    }
}
