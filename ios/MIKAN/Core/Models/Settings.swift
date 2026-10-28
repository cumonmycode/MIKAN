import Foundation

nonisolated struct StudioSettings: Codable, Hashable, Sendable {
    var name: String
    var address: String
    var phone: String
    var workingHours: String
    var instagram: String
    var website: String
    var about: String
    var timezone: String
    /// Opening time "HH:mm" in the studio time zone: the calendar grid starts here.
    var workdayStart: String
    /// Closing time "HH:mm" ("24:00" = midnight): the calendar grid ends here.
    var workdayEnd: String
    /// Prepayment rules on a cancellation / no-show; `nil` from a server that predates them (then never sent back).
    var cancellation: CancellationRules? = nil
    /// Where clients leave a review; `nil` from a server that predates them (then never sent back).
    var reviewLinks: ReviewLinks? = nil
    /// How clients book themselves; `nil` from a server that predates online booking (then never sent back).
    var onlineBooking: OnlineBookingSettings? = nil
    /// The till; `nil` from a server that predates the receipt in Telegram (then never sent back).
    var pos: PosSettings? = nil
}

/// `StudioSettings.pos`.
nonisolated struct PosSettings: Codable, Hashable, Sendable {
    /// The bot sends the receipt to the client's Telegram after a paid sale and tells them about a refund.
    var sendReceipt: Bool
}

/// `StudioSettings.cancellation`: what the studio keeps of a prepayment when a visit is cancelled late or missed.
nonisolated struct CancellationRules: Codable, Hashable, Sendable {
    /// A cancellation at least this many hours before the start is free; 0 = never free.
    var freeHours: Int
    /// Share (0…100) of the held prepayment kept after a later cancellation.
    var lateRetainPercent: Int
    /// Share (0…100) of the held prepayment kept after a no-show.
    var noShowRetainPercent: Int
    /// The server records that retain itself when the visit is cancelled late or missed.
    var autoRetain: Bool

    static let maxFreeHours = 336
}

/// `StudioSettings.reviewLinks`: `https://…` or "" (none).
nonisolated struct ReviewLinks: Codable, Hashable, Sendable {
    var yandex: String
    var twogis: String
    var google: String
}

extension StudioSettings {
    /// Tolerates `null` text fields — they become empty strings — and servers without working hours,
    /// cancellation rules, review links or online booking.
    nonisolated init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        func text(_ key: CodingKeys) throws -> String {
            try container.decodeIfPresent(String.self, forKey: key) ?? ""
        }
        self.init(
            name: try text(.name),
            address: try text(.address),
            phone: try text(.phone),
            workingHours: try text(.workingHours),
            instagram: try text(.instagram),
            website: try text(.website),
            about: try text(.about),
            timezone: try container.decodeIfPresent(String.self, forKey: .timezone) ?? "Europe/Moscow",
            workdayStart: try container.decodeIfPresent(String.self, forKey: .workdayStart) ?? WorkdayHours.standard.startText,
            workdayEnd: try container.decodeIfPresent(String.self, forKey: .workdayEnd) ?? WorkdayHours.standard.endText,
            cancellation: try container.decodeIfPresent(CancellationRules.self, forKey: .cancellation),
            reviewLinks: try container.decodeIfPresent(ReviewLinks.self, forKey: .reviewLinks),
            onlineBooking: try container.decodeIfPresent(OnlineBookingSettings.self, forKey: .onlineBooking)
        )
    }
}

nonisolated struct BotSettings: Codable, Hashable, Sendable {
    var enabled: Bool
    var aiEnabled: Bool
    var greeting: String
    var extraInstructions: String
    /// Studio-local hour (0–23) for aftercare messages with `dayOffset > 0`.
    var aftercareHour: Int
    var remindersEnabled: Bool
    /// Minutes before the appointment at which the bot sends a reminder, earliest first (1–6 values).
    var reminderOffsets: [Int]
    /// Studio-local "HH:MM" of the morning summary to staff chats, `nil` = off.
    var morningDigestAt: String?
    /// Studio-local "HH:MM" of the evening summary to staff chats, `nil` = off.
    var eveningDigestAt: String?
    // Read-only (ignored by PUT).
    let botUsername: String?
    let staffChatBound: Bool
    let aiConfigured: Bool
    /// The server knows `reminderOffsets`; older servers keep a single `reminderHoursBefore`. Not sent.
    var supportsReminderOffsets = true
    /// The server knows the staff digests (sends their keys, `null` included). Not sent.
    var supportsStaffDigests = true

    private enum CodingKeys: String, CodingKey {
        case enabled, aiEnabled, greeting, extraInstructions, aftercareHour, remindersEnabled
        case reminderOffsets, reminderHoursBefore
        case morningDigestAt, eveningDigestAt
        case botUsername, staffChatBound, aiConfigured
    }

    var reminderSchedule: ReminderSchedule {
        get { ReminderSchedule(offsets: reminderOffsets) }
        set { reminderOffsets = newValue.offsets }
    }

    /// What blocks saving the reminders, or `nil`.
    var reminderIssue: ReminderSchedule.Issue? {
        remindersEnabled ? reminderSchedule.issue : nil
    }
}

extension BotSettings {
    /// Servers without `reminderOffsets` get `[reminderHoursBefore * 60]`; servers without digests leave them off.
    nonisolated init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let offsets = try container.decodeIfPresent([Int].self, forKey: .reminderOffsets)
        self.init(
            enabled: try container.decode(Bool.self, forKey: .enabled),
            aiEnabled: try container.decode(Bool.self, forKey: .aiEnabled),
            greeting: try container.decodeIfPresent(String.self, forKey: .greeting) ?? "",
            extraInstructions: try container.decodeIfPresent(String.self, forKey: .extraInstructions) ?? "",
            aftercareHour: try container.decode(Int.self, forKey: .aftercareHour),
            remindersEnabled: try container.decode(Bool.self, forKey: .remindersEnabled),
            reminderOffsets: ReminderSchedule.offsets(
                decoded: offsets,
                legacyHours: try container.decodeIfPresent(Int.self, forKey: .reminderHoursBefore)
            ),
            morningDigestAt: try container.decodeIfPresent(String.self, forKey: .morningDigestAt),
            eveningDigestAt: try container.decodeIfPresent(String.self, forKey: .eveningDigestAt),
            botUsername: try container.decodeIfPresent(String.self, forKey: .botUsername),
            staffChatBound: try container.decodeIfPresent(Bool.self, forKey: .staffChatBound) ?? false,
            aiConfigured: try container.decodeIfPresent(Bool.self, forKey: .aiConfigured) ?? false,
            supportsReminderOffsets: offsets != nil,
            supportsStaffDigests: container.contains(.morningDigestAt) || container.contains(.eveningDigestAt)
        )
    }

    /// The `PUT /settings/bot` body: editable fields only. New servers get `reminderOffsets`;
    /// older ones also get `reminderHoursBefore` (the earliest reminder), the only value they keep.
    /// The digest times go only to servers that sent them, with an explicit `null` for a summary turned off.
    nonisolated func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(enabled, forKey: .enabled)
        try container.encode(aiEnabled, forKey: .aiEnabled)
        try container.encode(greeting, forKey: .greeting)
        try container.encode(extraInstructions, forKey: .extraInstructions)
        try container.encode(aftercareHour, forKey: .aftercareHour)
        try container.encode(remindersEnabled, forKey: .remindersEnabled)
        try container.encode(reminderOffsets, forKey: .reminderOffsets)
        if !supportsReminderOffsets {
            try container.encode(reminderSchedule.legacyHoursBefore, forKey: .reminderHoursBefore)
        }
        if supportsStaffDigests {
            try container.encode(Nullable(morningDigestAt), forKey: .morningDigestAt)
            try container.encode(Nullable(eveningDigestAt), forKey: .eveningDigestAt)
        }
    }
}
