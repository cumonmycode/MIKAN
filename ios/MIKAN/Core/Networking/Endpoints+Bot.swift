import Foundation

// MARK: - Telegram bot, booking requests, knowledge base

extension APIClient {
    func chats() async throws -> [BotChat] {
        let response: ItemsResponse<BotChat> = try await request(.get, "bot/chats")
        return response.items
    }

    /// Ascending by time; without `beforeId` returns the latest page.
    func chatMessages(chatId: Int64, beforeId: Int? = nil, limit: Int = 50) async throws -> [BotMessage] {
        let response: ItemsResponse<BotMessage> = try await request(.get, "bot/chats/\(chatId)/messages", query: queryItems([
            "beforeId": beforeId.map(String.init),
            "limit": String(limit),
        ]))
        return response.items
    }

    /// The bytes of a picture a client sent (`BotMessage.photoFile`).
    func chatPhoto(file: String) async throws -> Data {
        try await requestData(.get, "bot/photos/\(file)")
    }

    func sendChatMessage(chatId: Int64, text: String) async throws -> BotMessage {
        try await request(.post, "bot/chats/\(chatId)/messages", body: TextBody(text: text))
    }

    func markChatRead(chatId: Int64) async throws {
        try await requestVoid(.post, "bot/chats/\(chatId)/read")
    }

    func setChatAIPaused(chatId: Int64, paused: Bool) async throws -> BotChat {
        try await request(.patch, "bot/chats/\(chatId)", body: AIPausedBody(aiPaused: paused))
    }

    /// Makes the chat the staff chat of an active employee (for employees who never shared their phone with the bot);
    /// the bot greets them with the staff keyboard. Returns the chat with `employee`.
    func bindChatEmployee(chatId: Int64, employeeId: Int) async throws -> BotChat {
        try await request(.put, "bot/chats/\(chatId)/employee", body: ChatEmployeeBody(employeeId: employeeId))
    }

    /// The chat becomes an ordinary client chat; the employee links again by sharing their phone with the bot.
    func unlinkChatEmployee(chatId: Int64) async throws {
        try await requestVoid(.delete, "bot/chats/\(chatId)/employee")
    }

    func scheduledMessages(status: ScheduledStatus) async throws -> [ScheduledMessage] {
        let response: ItemsResponse<ScheduledMessage> = try await request(
            .get, "bot/scheduled",
            query: queryItems(["status": status.rawValue])
        )
        return response.items
    }

    func cancelScheduledMessage(id: Int) async throws -> ScheduledMessage {
        try await request(.post, "bot/scheduled/\(id)/cancel")
    }

    func staffCode() async throws -> StaffCode {
        try await request(.post, "bot/staff-code")
    }

    func testBot(text: String) async throws -> BotTestReply {
        try await request(.post, "bot/test", body: TextBody(text: text))
    }

    func bookingRequests(status: BookingStatus) async throws -> [BookingRequest] {
        let response: ItemsResponse<BookingRequest> = try await request(
            .get, "booking-requests",
            query: queryItems(["status": status.rawValue])
        )
        return response.items
    }

    func setBookingRequestStatus(id: Int, _ status: BookingStatus) async throws -> BookingRequest {
        try await request(.patch, "booking-requests/\(id)", body: StatusBody(status: status))
    }

    func knowledge() async throws -> [KnowledgeEntry] {
        let response: ItemsResponse<KnowledgeEntry> = try await request(.get, "knowledge")
        return response.items
    }

    func createKnowledge(_ body: KnowledgeBody) async throws -> KnowledgeEntry {
        try await request(.post, "knowledge", body: body)
    }

    func updateKnowledge(id: Int, _ body: KnowledgeBody) async throws -> KnowledgeEntry {
        try await request(.patch, "knowledge/\(id)", body: body)
    }

    func deleteKnowledge(id: Int) async throws {
        try await requestVoid(.delete, "knowledge/\(id)")
    }
}
