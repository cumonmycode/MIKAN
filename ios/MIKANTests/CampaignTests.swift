import Foundation
import Testing
@testable import MIKAN

/// Campaigns (docs/API.md «Campaigns»): segment encoding, the `{name}` preview, text limits and tolerant decoding.
@MainActor
struct CampaignSegmentTests {
    private func json(_ segment: CampaignSegment) throws -> [String: Any] {
        let data = try JSONCoding.makeEncoder().encode(segment)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("Without conditions the segment is an empty object")
    func emptySegment() throws {
        #expect(try json(CampaignSegmentDraft().segment).isEmpty)
        #expect(try json(CampaignSegment()).isEmpty, "false flags and empty lists are no conditions")
        #expect(CampaignSegment().isEmpty)
    }

    @Test("Only the conditions that are on are sent")
    func onlySetConditions() throws {
        var draft = CampaignSegmentDraft()
        draft.usesLastVisit = true
        draft.lastVisitMin = 3
        draft.lastVisitHasMax = true
        draft.lastVisitMax = 12
        draft.categories = [.tattoo, .piercing]
        draft.masterIds = [5, 2]
        draft.hasBonuses = true
        draft.minVisits = 7 // switched off: kept for later, not sent
        draft.createdWithinDays = 90 // switched off

        let body = try json(draft.segment)
        #expect(Set(body.keys) == ["lastVisitMonthsAgoMin", "lastVisitMonthsAgoMax", "categories", "masterIds", "hasBonuses"])
        #expect(body["lastVisitMonthsAgoMin"] as? Int == 3)
        #expect(body["lastVisitMonthsAgoMax"] as? Int == 12)
        #expect(body["categories"] as? [String] == ["tattoo", "piercing"], "in catalog order")
        #expect(body["masterIds"] as? [Int] == [2, 5], "sorted")
        #expect(body["hasBonuses"] as? Bool == true)
    }

    @Test("Each optional condition goes out once switched on")
    func switchedOnConditions() throws {
        var draft = CampaignSegmentDraft()
        draft.usesMinVisits = true
        draft.minVisits = 2
        draft.birthdayMonth = 11
        draft.usesCreatedWithin = true
        draft.createdWithinDays = 30
        let body = try json(draft.segment)
        #expect(Set(body.keys) == ["minVisits", "birthdayMonth", "createdWithinDays"])
        #expect(body["minVisits"] as? Int == 2)
        #expect(body["birthdayMonth"] as? Int == 11)
        #expect(body["createdWithinDays"] as? Int == 30)
    }

    @Test("«Ещё не были у нас» drops every condition about visits")
    func neverVisitedDropsVisitConditions() throws {
        var draft = CampaignSegmentDraft()
        draft.usesLastVisit = true
        draft.usesMinVisits = true
        draft.categories = [.piercing]
        draft.masterIds = [2]
        draft.neverVisited = true
        draft.hasBonuses = true
        let body = try json(draft.segment)
        #expect(Set(body.keys) == ["neverVisited", "hasBonuses"])
        #expect(body["neverVisited"] as? Bool == true)
        #expect(draft.issue == nil)
    }

    @Test("Last visit: no lower bound sends only the upper one; «до» below «от» is an error")
    func lastVisitBounds() throws {
        var draft = CampaignSegmentDraft()
        draft.usesLastVisit = true
        draft.lastVisitMin = 0
        #expect(try json(draft.segment).isEmpty, "any time, no upper bound — no condition")
        draft.lastVisitHasMax = true
        draft.lastVisitMax = 6
        #expect(Set(try json(draft.segment).keys) == ["lastVisitMonthsAgoMax"])

        draft.lastVisitMin = 8
        #expect(draft.issue != nil)
        draft.lastVisitMax = 8
        #expect(draft.issue == nil)
    }

    @Test("A saved segment opens in the builder as it was")
    func roundTrip() throws {
        let saved = try JSONCoding.makeDecoder().decode(CampaignSegment.self, from: Data("""
        { "lastVisitMonthsAgoMin": 3, "lastVisitMonthsAgoMax": 12, "neverVisited": false, "categories": ["piercing"],
          "masterIds": [2], "minVisits": 2, "birthdayMonth": 11, "hasBonuses": true, "createdWithinDays": 30 }
        """.utf8))
        let draft = CampaignSegmentDraft(segment: saved)
        #expect(draft.usesLastVisit && draft.lastVisitHasMax && draft.usesMinVisits && draft.usesCreatedWithin)
        #expect(draft.segment == saved)

        let maxOnly = CampaignSegment(lastVisitMonthsAgoMax: 6)
        #expect(CampaignSegmentDraft(segment: maxOnly).segment == maxOnly)
    }

    @Test("The card names the conditions in words")
    func summary() {
        let segment = CampaignSegment(
            lastVisitMonthsAgoMin: 3, lastVisitMonthsAgoMax: 12, categories: [.piercing], masterIds: [2, 9],
            birthdayMonth: 11, hasBonuses: true
        )
        let lines = CampaignSegmentText.lines(segment) { $0 == 2 ? "Анна" : nil }
        #expect(lines == [
            "Последний визит: 3–12 мес. назад",
            "Были на: пирсинг",
            "У мастеров: Анна, мастер №9",
            "День рождения в ноябре",
            "Есть бонусы",
        ])
        #expect(CampaignSegmentText.lines(CampaignSegment()) { _ in nil } == ["Все клиенты, которые получают новости"])
    }
}

@MainActor
struct CampaignTextTests {
    @Test("{name} becomes the client's first name everywhere in the preview")
    func personalized() {
        #expect(CampaignText.personalized("{name}, привет! {name}, ждём вас", name: "Анна") == "Анна, привет! Анна, ждём вас")
        #expect(CampaignText.personalized("Без имени", name: "Анна") == "Без имени")
    }

    @Test("The preview takes the first word of a sample client, else a stock name")
    func previewName() {
        #expect(CampaignText.previewName(nil) == CampaignText.sampleName)
        #expect(CampaignText.previewName(ClientRef(id: 1, name: "Иван Петров", phone: nil, telegramLinked: true)) == "Иван")
        #expect(CampaignText.previewName(ClientRef(id: 1, name: "Мария", lastName: "Ким", phone: nil, telegramLinked: true)) == "Мария")
        #expect(CampaignText.previewName(ClientRef(id: 1, name: "  ", phone: nil, telegramLinked: true)) == CampaignText.sampleName)
    }

    @Test("«Имя клиента» puts {name} at the cursor, over a selection or at the end")
    func insertToken() {
        let text = "Привет, !"
        let cursor = text.index(text.startIndex, offsetBy: 8)
        let atCursor = CampaignText.inserting("{name}", into: text, replacing: cursor..<cursor)
        #expect(atCursor.text == "Привет, {name}!")
        #expect(atCursor.cursorOffset == 14)

        let word = "Привет, друг!"
        let start = word.index(word.startIndex, offsetBy: 8)
        let end = word.index(start, offsetBy: 4)
        #expect(CampaignText.inserting("{name}", into: word, replacing: start..<end).text == "Привет, {name}!")

        let appended = CampaignText.inserting("{name}", into: "Ждём вас, ", replacing: nil)
        #expect(appended.text == "Ждём вас, {name}")
        #expect(appended.cursorOffset == appended.text.count)
    }

    @Test("A text message holds 3 500 characters, a photo caption 1 024")
    func limits() {
        #expect(CampaignText.limit(hasImage: false) == 3_500)
        #expect(CampaignText.limit(hasImage: true) == 1_024)
        let long = String(repeating: "а", count: 3_500)
        #expect(CampaignText.issue(long, hasImage: false) == nil)
        #expect(CampaignText.issue(long + "а", hasImage: false) != nil)
        #expect(CampaignText.issue(long, hasImage: true) != nil, "too long for a caption")
        let caption = String(repeating: "б", count: 1_024)
        #expect(CampaignText.issue(caption, hasImage: true) == nil)
        #expect(CampaignText.isTooLong(caption + "б", hasImage: true))
        #expect(CampaignText.counter(caption, hasImage: true) == "1\u{00A0}024 / 1\u{00A0}024")
    }

    @Test("Length is counted like the server: trimmed, an emoji takes two")
    func lengthLikeServer() {
        #expect(CampaignText.length("  привет \n") == 6)
        #expect(CampaignText.length("🎂") == 2)
        let emojis = String(repeating: "🎂", count: 512)
        #expect(CampaignText.issue(emojis, hasImage: true) == nil)
        #expect(CampaignText.issue(emojis + "!", hasImage: true) != nil)
        #expect(CampaignText.issue("   ", hasImage: false) != nil, "an empty text can't be sent")
    }
}

@MainActor
struct CampaignDraftTests {
    private func body(_ draft: CampaignDraft) throws -> [String: Any] {
        let data = try JSONCoding.makeEncoder().encode(draft.body)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private var valid: CampaignDraft {
        var draft = CampaignDraft()
        draft.title = " Осенняя акция "
        draft.text = "{name}, скидка 15% на пирсинг"
        return draft
    }

    @Test("A campaign needs a name and a text")
    func required() {
        var draft = CampaignDraft()
        #expect(draft.issue != nil)
        draft.title = "Акция"
        #expect(draft.issue != nil)
        draft.text = "Текст"
        #expect(draft.issue == nil)
        draft.title = String(repeating: "я", count: CampaignText.maxTitleLength + 1)
        #expect(draft.titleIssue != nil)
    }

    @Test("A picture tightens the text limit")
    func imageLimit() {
        var draft = valid
        draft.text = String(repeating: "а", count: 2_000)
        #expect(draft.textIssue == nil)
        draft.imageUrl = "/uploads/a.jpg"
        #expect(draft.textIssue != nil)
    }

    @Test("A link button needs a text and an https:// address")
    func linkButton() {
        var draft = valid
        draft.buttonChoice = .link
        #expect(draft.buttonIssue != nil, "the prefilled https:// alone is no link")
        draft.linkURL = "http://mikan.studio"
        #expect(draft.buttonIssue != nil)
        draft.linkURL = " https://mikan.studio/autumn "
        #expect(draft.buttonIssue == nil)
        draft.linkTitle = String(repeating: "🎁", count: 32)
        #expect(draft.buttonIssue == nil, "64 UTF-16 units — the server's limit")
        draft.linkTitle += "!"
        #expect(draft.buttonIssue != nil)
        draft.linkTitle = " "
        #expect(draft.buttonIssue != nil)
        draft.buttonChoice = .none
        #expect(draft.buttonIssue == nil)
    }

    @Test("The body sends the trimmed text, null for no picture and no button, and the button's shape")
    func bodyShape() throws {
        var draft = valid
        draft.buttonChoice = .none
        var sent = try body(draft)
        #expect(sent["title"] as? String == "Осенняя акция")
        #expect(sent["imageUrl"] is NSNull)
        #expect(sent["button"] is NSNull)
        #expect((sent["segment"] as? [String: Any])?.isEmpty == true)

        draft.buttonChoice = .book
        draft.imageUrl = "/uploads/a.jpg"
        sent = try body(draft)
        #expect(sent["imageUrl"] as? String == "/uploads/a.jpg")
        let book = try #require(sent["button"] as? [String: Any])
        #expect(book["kind"] as? String == "book")
        #expect(book["text"] as? String == CampaignButton.bookTitle)
        #expect(book["url"] == nil)

        draft.buttonChoice = .link
        draft.linkTitle = "Подробнее"
        draft.linkURL = "https://mikan.studio"
        let link = try #require(try body(draft)["button"] as? [String: Any])
        #expect(link["kind"] as? String == "url")
        #expect(link["url"] as? String == "https://mikan.studio")
    }

    @Test("A saved campaign opens in the editor unchanged")
    func editorRoundTrip() throws {
        let campaign = try JSONCoding.makeDecoder().decode(Campaign.self, from: Data(CampaignFixtures.full.utf8))
        let draft = CampaignDraft(campaign: campaign)
        #expect(draft.buttonChoice == .link)
        #expect(draft.linkURL == "https://mikan.studio/autumn")
        #expect(draft.body.segment == campaign.segment)
        #expect(draft.issue == nil)
    }
}

enum CampaignFixtures {
    static let full = """
    { "id": 7, "title": "Осенняя акция", "text": "{name}, скидка 15%", "imageUrl": "/uploads/autumn.jpg",
      "button": { "text": "Подробнее", "kind": "url", "url": "https://mikan.studio/autumn" },
      "segment": { "lastVisitMonthsAgoMin": 3, "categories": ["piercing"], "hasBonuses": true },
      "status": "sending", "scheduledAt": null, "startedAt": "2026-10-15T11:00:00.000Z", "finishedAt": null,
      "stats": { "recipients": 124, "sent": 80, "failed": 2, "blocked": 3, "pending": 39 },
      "createdBy": { "id": 1, "name": "Анна", "color": "#FF7A1A" },
      "createdAt": "2026-10-15T10:00:00.000Z", "updatedAt": "2026-10-15T11:00:00.000Z" }
    """
}

@MainActor
struct CampaignDecodingTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONCoding.makeDecoder().decode(T.self, from: Data(json.utf8))
    }

    @Test("A campaign decodes from the contract shape")
    func full() throws {
        let campaign = try decode(Campaign.self, CampaignFixtures.full)
        #expect(campaign.status == .sending)
        #expect(campaign.button == CampaignButton(text: "Подробнее", kind: .url, url: "https://mikan.studio/autumn"))
        #expect(campaign.segment == CampaignSegment(lastVisitMonthsAgoMin: 3, categories: [.piercing], hasBonuses: true))
        #expect(campaign.stats.recipients == 124)
        #expect(campaign.stats.processed == 85)
        #expect(abs(campaign.stats.progress - 85.0 / 124.0) < 0.0001)
        #expect(campaign.createdBy?.name == "Анна")
        #expect(campaign.startedAt == Fixtures.referenceDate)
    }

    @Test("Missing and unknown parts never break a campaign")
    func tolerant() throws {
        let minimal = try decode(Campaign.self, #"{ "id": 3, "createdAt": "2026-10-15T11:00:00Z" }"#)
        #expect(minimal.title.isEmpty && minimal.text.isEmpty)
        #expect(minimal.button == nil && minimal.imageUrl == nil && minimal.createdBy == nil)
        #expect(minimal.segment.isEmpty)
        #expect(minimal.stats == CampaignStats())
        #expect(minimal.status == .unknown)
        #expect(minimal.updatedAt == minimal.createdAt)

        let future = try decode(Campaign.self, """
        { "id": 4, "title": "Т", "text": "Т", "status": "paused", "button": { "text": "?", "kind": "game" },
          "segment": { "categories": ["laser", "tattoo"], "neverVisited": true }, "stats": { "sent": 5 },
          "createdBy": null, "createdAt": "2026-10-15T11:00:00.000Z", "updatedAt": "2026-10-15T11:00:00.000Z" }
        """)
        #expect(future.status == .unknown)
        #expect(!future.status.isEditable && !future.status.canCancel && !future.status.canDelete)
        #expect(future.button == nil, "an unknown button kind drops only the button")
        #expect(future.segment.categories == [.tattoo], "unknown categories are skipped")
        #expect(future.segment.neverVisited)
        #expect(future.stats == CampaignStats(sent: 5))
    }

    @Test("What each status allows")
    func statuses() {
        #expect(CampaignStatus.draft.isEditable && CampaignStatus.draft.canSend && CampaignStatus.draft.canDelete)
        #expect(!CampaignStatus.draft.canCancel)
        #expect(CampaignStatus.scheduled.isEditable && CampaignStatus.scheduled.canCancel && !CampaignStatus.scheduled.canDelete)
        #expect(CampaignStatus.sending.canCancel && !CampaignStatus.sending.isEditable)
        for status in [CampaignStatus.sent, .cancelled] {
            #expect(!status.isEditable && !status.canCancel && !status.canDelete)
        }
    }

    @Test("The audience preview tolerates a missing sample")
    func audience() throws {
        let full = try decode(CampaignAudience.self, """
        { "count": 2, "sample": [ { "id": 1, "name": "Иван", "lastName": "Петров", "phone": null, "telegramLinked": true } ] }
        """)
        #expect(full.count == 2)
        #expect(full.sample.first?.fullName == "Иван Петров")
        #expect(try decode(CampaignAudience.self, #"{ "count": 0 }"#).sample.isEmpty)
    }

    @Test("marketingOptOut: read when sent, nil from a server without campaigns; the toggle sends only it")
    func clientMarketingOptOut() throws {
        let legacy = try Fixtures.decode(Client.self, Fixtures.clientInList)
        #expect(legacy.marketingOptOut == nil)

        let optedOut = Fixtures.clientInList.replacingOccurrences(of: #""stats": null"#, with: #""stats": null, "marketingOptOut": true"#)
        #expect(try Fixtures.decode(Client.self, optedOut).marketingOptOut == true)
        let receives = Fixtures.clientInList.replacingOccurrences(of: #""stats": null"#, with: #""stats": null, "marketingOptOut": false"#)
        #expect(try Fixtures.decode(Client.self, receives).marketingOptOut == false)

        let data = try JSONCoding.makeEncoder().encode(MarketingOptOutBody(marketingOptOut: true))
        let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(body.count == 1)
        #expect(body["marketingOptOut"] as? Bool == true)
    }
}

@MainActor
struct CampaignActionTests {
    @Test("Sending asks with the number of recipients")
    func sendConfirmation() {
        #expect(CampaignConfirmation.sendNow(recipients: 1).title == "Отправить 1 клиенту?")
        #expect(CampaignConfirmation.sendNow(recipients: 124).title == "Отправить 124 клиентам?")
        #expect(CampaignConfirmation.sendNow(recipients: 0).title == "Подходящих клиентов нет")
        #expect(CampaignConfirmation.sendNow(recipients: nil).title == "Отправить рассылку?")
        #expect(!CampaignConfirmation.sendNow(recipients: 5).isDestructive)
        #expect(CampaignConfirmation.delete.isDestructive)
    }

    @Test("A schedule starts on a quarter of an hour at least an hour ahead, never in the past")
    func schedule() {
        let now = Fixtures.referenceDate.addingTimeInterval(7 * 60) // 11:07 UTC
        let suggested = CampaignSchedule.suggestedDate(now: now)
        #expect(suggested == Fixtures.referenceDate.addingTimeInterval(75 * 60)) // 12:15
        #expect(CampaignSchedule.isValid(suggested, now: now))
        #expect(!CampaignSchedule.isValid(now, now: now))
        #expect(!CampaignSchedule.isValid(now.addingTimeInterval(-60), now: now))
        #expect(CampaignSchedule.isValid(CampaignSchedule.latest(now: now), now: now))
        #expect(!CampaignSchedule.isValid(CampaignSchedule.latest(now: now).addingTimeInterval(60), now: now), "at most a year ahead")
    }

    @Test("An open card refreshes while sending, less often while scheduled, never once finished")
    func refresh() {
        #expect(CampaignRefresh.interval(for: .sending) == .seconds(3))
        #expect(CampaignRefresh.interval(for: .scheduled) == .seconds(15))
        for status in [CampaignStatus.draft, .sent, .cancelled, .unknown] {
            #expect(CampaignRefresh.interval(for: status) == nil)
        }
    }

    @Test("Owner and admin run campaigns and edit retention; a master does neither")
    func permissions() {
        func permissions(_ role: EmployeeRole) -> Permissions { Permissions(role: role, employeeId: 1) }
        #expect(permissions(.owner).runsCampaigns && permissions(.owner).editsRetention)
        #expect(permissions(.admin).runsCampaigns && permissions(.admin).editsRetention)
        #expect(!permissions(.master).runsCampaigns && !permissions(.master).editsRetention)
    }

    @Test("The client sees the campaign button and the opt-out under every message")
    func previewButtons() {
        #expect(CampaignPresentation.buttons(nil) == [CampaignPresentation.optOutButtonTitle])
        #expect(CampaignPresentation.buttons(.book) == [CampaignButton.bookTitle, CampaignPresentation.optOutButtonTitle])
    }
}
