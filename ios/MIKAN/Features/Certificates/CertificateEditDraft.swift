import Foundation

/// What can be changed on a sold gift certificate (`PATCH /certificates/:id`, docs/API.md «Gift certificates»): the
/// recipient and the note — a till action — and, by the owner only, until when it is valid. Only what changed is sent,
/// with the server's limits checked first.
nonisolated struct CertificateEditDraft: Equatable, Sendable {
    static let maxRecipientLength = 100
    static let maxNoteLength = 1000

    var recipientName: String
    var note: String
    /// `false` — the certificate never expires.
    var expires: Bool
    /// The last day it can pay, studio calendar; used when `expires`.
    var lastDay: Date

    private let originalRecipient: String
    private let originalNote: String
    private let originalExpiresAt: Date?
    private let calendar: Calendar

    /// A certificate without an expiry that gets one is offered a year from `now`.
    init(_ certificate: GiftCertificate, now: Date = .now, calendar: Calendar = .app) {
        recipientName = certificate.recipientName ?? ""
        note = certificate.note ?? ""
        expires = certificate.expiresAt != nil
        let proposed = certificate.expiresAt ?? calendar.date(byAdding: .year, value: 1, to: now) ?? now
        lastDay = calendar.startOfDay(for: proposed)
        originalRecipient = certificate.recipientName.nonEmpty ?? ""
        originalNote = certificate.note.nonEmpty ?? ""
        originalExpiresAt = certificate.expiresAt
        self.calendar = calendar
    }

    /// The server refuses a new expiry for a certificate that no longer works (`409`).
    static func allowsExpiryChange(_ status: GiftCertificateStatus) -> Bool {
        status == .active || status == .used
    }

    /// The instant sent for `lastDay`: its last second, so the card and the bot name that very day.
    static func expiresAt(lastDay: Date, calendar: Calendar = .app) -> Date {
        let start = calendar.startOfDay(for: lastDay)
        let next = calendar.date(byAdding: .day, value: 1, to: start) ?? start
        return next.addingTimeInterval(-1)
    }

    var recipientChanged: Bool { recipientName.trimmed != originalRecipient }
    var noteChanged: Bool { note.trimmed != originalNote }

    var expiryChanged: Bool {
        switch (expires, originalExpiresAt) {
        case (false, nil): false
        case (false, .some): true
        case (true, nil): true
        case (true, .some(let current)): !calendar.isDate(lastDay, inSameDayAs: current)
        }
    }

    var hasChanges: Bool { recipientChanged || noteChanged || expiryChanged }

    /// What blocks saving, in Russian, or `nil`. The server counts UTF-16 code units of the trimmed text.
    func issue(now: Date = .now) -> String? {
        if recipientName.trimmed.utf16.count > Self.maxRecipientLength {
            return "Имя получателя — не длиннее \(Self.maxRecipientLength) символов."
        }
        if note.trimmed.utf16.count > Self.maxNoteLength {
            return "Заметка — не длиннее \(Self.maxNoteLength) символов."
        }
        if expiryChanged, expires, Self.expiresAt(lastDay: lastDay, calendar: calendar) <= now {
            return "Срок действия должен быть в будущем."
        }
        return nil
    }

    func canSave(now: Date = .now) -> Bool { hasChanges && issue(now: now) == nil }

    /// Only the changed fields: a cleared text is sent as `null`, «бессрочно» as `expiresAt: null`.
    var body: CertificatePatchBody {
        CertificatePatchBody(
            recipientName: recipientChanged ? Nullable(recipientName.nonEmpty) : nil,
            note: noteChanged ? Nullable(note.nonEmpty) : nil,
            expiresAt: expiryChanged ? Nullable(expires ? Self.expiresAt(lastDay: lastDay, calendar: calendar) : nil) : nil
        )
    }
}

/// `PATCH /certificates/:id`: an omitted field stays as it is.
nonisolated struct CertificatePatchBody: Encodable, Equatable, Sendable {
    var recipientName: Nullable<String>?
    var note: Nullable<String>?
    /// Owner only; `null` — never expires.
    var expiresAt: Nullable<Date>?
}
