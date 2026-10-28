import Foundation

/// `Appointment.channel`: where the appointment was booked (docs/API.md «Appointment»).
nonisolated enum AppointmentChannel: String, Codable, Hashable, Sendable {
    /// Staff in the app.
    case app
    /// The AI in Telegram.
    case bot
    /// The Telegram Mini App.
    case miniapp
    /// The booking page (`PUBLIC_URL/book`).
    case web
    /// A channel this build does not know yet (sent by a newer server).
    case other

    /// Booked by the client themselves.
    var isOnline: Bool { self != .app }
}

nonisolated extension AppointmentChannel {
    /// An unknown channel reads as `.other`, so a newer server never breaks the calendar.
    init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AppointmentChannel(rawValue: raw) ?? .other
    }
}

/// `Appointment.onlineState`: an online booking the studio has not settled yet.
nonisolated enum OnlineBookingState: String, Codable, CaseIterable, Hashable, Sendable {
    /// The time is held until `holdUntil` while the client pays the prepayment by QR.
    case awaitingPayment = "awaiting_payment"
    /// Staff confirm or reject it.
    case awaitingConfirmation = "awaiting_confirmation"
}

/// `StudioSettings.onlineBooking`: how clients book themselves (bot, Mini App, booking page).
nonisolated struct OnlineBookingSettings: Codable, Hashable, Sendable {
    /// `false` — the booking page says «Онлайн-запись временно недоступна», the bot takes booking requests.
    var enabled = true
    /// The earliest start from now, minutes (0…2880).
    var leadMinutes = 120
    /// How far ahead clients may book, days (1…180).
    var horizonDays = 60
    /// Time to pay the prepayment, minutes (5…60).
    var holdMinutes = 15
    /// The grid of offered starts: 15, 30 or 60 minutes.
    var stepMinutes = 30
    /// Shown to clients on the booking page (≤ 500 characters).
    var note = ""
    /// `confirmationHours`: when an unconfirmed online booking is rejected by itself; `nil` — the server predates it
    /// (then never sent back).
    var autoReject: OnlineAutoReject? = nil

    static let leadRange = 0...2880
    static let horizonRange = 1...180
    static let holdRange = 5...60
    static let steps = [15, 30, 60]
    static let maxNoteLength = 500
}

/// `onlineBooking.confirmationHours`: an online booking still waiting for confirmation that long after it was made —
/// or 2 hours before its start, if that comes first — is rejected by itself (docs/API.md «StudioSettings»).
nonisolated enum OnlineAutoReject: Hashable, Sendable {
    /// `null`: it waits for staff however long it takes.
    case never
    /// 1…168 hours after the booking was made.
    case after(hours: Int)

    static let hoursRange = 1...168
    static let standard = OnlineAutoReject.after(hours: 24)
    /// Whatever the hours, a booking is rejected this long before its start.
    static let hoursBeforeStart = 2

    /// The JSON value: hours, or `nil` for `null`.
    var hours: Int? {
        switch self {
        case .never: nil
        case .after(let hours): hours
        }
    }

    init(hours: Int?) {
        self = hours.map { .after(hours: $0) } ?? .never
    }
}

nonisolated extension OnlineBookingSettings {
    private enum CodingKeys: String, CodingKey {
        case enabled, leadMinutes, horizonDays, holdMinutes, stepMinutes, note, confirmationHours
    }

    /// A missing or `null` field takes the documented default; `confirmationHours: null` means «never», while a
    /// server without the key leaves `autoReject` unknown.
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = OnlineBookingSettings()
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? defaults.enabled
        leadMinutes = try c.decodeIfPresent(Int.self, forKey: .leadMinutes) ?? defaults.leadMinutes
        horizonDays = try c.decodeIfPresent(Int.self, forKey: .horizonDays) ?? defaults.horizonDays
        holdMinutes = try c.decodeIfPresent(Int.self, forKey: .holdMinutes) ?? defaults.holdMinutes
        stepMinutes = try c.decodeIfPresent(Int.self, forKey: .stepMinutes) ?? defaults.stepMinutes
        note = try c.decodeIfPresent(String.self, forKey: .note) ?? defaults.note
        if c.contains(.confirmationHours) {
            autoReject = OnlineAutoReject(hours: try c.decodeIfPresent(Int.self, forKey: .confirmationHours))
        }
    }

    /// The PUT body: `confirmationHours` only to a server that sent it, `null` for «never».
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(enabled, forKey: .enabled)
        try c.encode(leadMinutes, forKey: .leadMinutes)
        try c.encode(horizonDays, forKey: .horizonDays)
        try c.encode(holdMinutes, forKey: .holdMinutes)
        try c.encode(stepMinutes, forKey: .stepMinutes)
        try c.encode(note, forKey: .note)
        if let autoReject {
            try c.encode(Nullable(autoReject.hours), forKey: .confirmationHours)
        }
    }
}

/// `POST /appointments/:id/online/reject`.
nonisolated struct OnlineRejectBody: Encodable, Equatable, Sendable {
    /// Told to the client; omitted when blank.
    let reason: String?

    init(reason: String) {
        self.reason = reason.nonEmpty
    }
}

/// `POST /devices`: the APNs token of this iPhone for the signed-in employee.
nonisolated struct DeviceBody: Encodable, Equatable, Sendable {
    let token: String
    let environment: PushEnvironment
}

/// Which APNs the token belongs to: Debug builds get sandbox tokens, TestFlight / App Store ones production.
nonisolated enum PushEnvironment: String, Encodable, Sendable {
    case production
    case sandbox

    static var current: PushEnvironment {
        #if DEBUG
        .sandbox
        #else
        .production
        #endif
    }
}
