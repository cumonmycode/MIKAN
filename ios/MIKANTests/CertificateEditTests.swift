import Foundation
import Testing
@testable import MIKAN

/// Editing a gift certificate (`PATCH /certificates/:id`, docs/API.md «Gift certificates», «Roles»): only what changed
/// is sent, the server's limits are checked first, the expiry is the owner's.
@MainActor
struct CertificateEditTests {
    /// 2026-10-15 11:00 UTC = 14:00 in Moscow.
    private let now = Fixtures.referenceDate

    private func moscow() throws -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "Europe/Moscow"))
        return calendar
    }

    private func certificate(
        status: GiftCertificateStatus = .active, expiresAt: Date? = nil, recipient: String? = "Маше", note: String? = nil
    ) -> GiftCertificate {
        GiftCertificate(
            id: 5, code: "MIKAN-7K3Q-9F2D", amount: 5_000, balance: 5_000, status: status, expiresAt: expiresAt,
            buyer: nil, recipientName: recipient, note: note, saleId: nil, saleNumber: nil, createdAt: now
        )
    }

    private func encoded(_ body: CertificatePatchBody) throws -> [String: Any] {
        let data = try JSONCoding.makeEncoder().encode(body)
        return try #require(try JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) as? [String: Any])
    }

    @Test("An untouched certificate has nothing to save and sends an empty body")
    func untouched() throws {
        let expiry = now.addingTimeInterval(86_400 * 300)
        let draft = CertificateEditDraft(certificate(expiresAt: expiry, note: "Подарок"), now: now, calendar: try moscow())
        #expect(!draft.hasChanges)
        #expect(!draft.canSave(now: now))
        #expect(draft.issue(now: now) == nil)
        #expect(draft.body == CertificatePatchBody())
        #expect(try encoded(draft.body).isEmpty)
    }

    @Test("A changed recipient goes trimmed, a cleared one as null, spaces alone change nothing")
    func recipient() throws {
        var draft = CertificateEditDraft(certificate(), now: now, calendar: try moscow())
        draft.recipientName = "  Маше  "
        #expect(!draft.hasChanges)
        draft.recipientName = " Даше "
        #expect(draft.canSave(now: now))
        let sent = try encoded(draft.body)
        #expect(sent["recipientName"] as? String == "Даше")
        #expect(sent.keys.sorted() == ["recipientName"])

        draft.recipientName = "   "
        let cleared = try encoded(draft.body)
        #expect(cleared["recipientName"] is NSNull)
    }

    @Test("A new note goes alone; the server's limits block saving")
    func noteAndLimits() throws {
        var draft = CertificateEditDraft(certificate(note: nil), now: now, calendar: try moscow())
        draft.note = "Подарок на день рождения"
        #expect(try encoded(draft.body).keys.sorted() == ["note"])

        draft.note = String(repeating: "я", count: CertificateEditDraft.maxNoteLength)
        #expect(draft.issue(now: now) == nil)
        draft.note = String(repeating: "я", count: CertificateEditDraft.maxNoteLength + 1)
        #expect(draft.issue(now: now)?.contains("1000") == true)
        #expect(!draft.canSave(now: now))

        draft.note = ""
        draft.recipientName = String(repeating: "🙂", count: 50)
        #expect(draft.issue(now: now) == nil, "50 emoji are 100 UTF-16 units, as the server counts")
        draft.recipientName = String(repeating: "🙂", count: 51)
        #expect(draft.issue(now: now)?.contains("100") == true)
    }

    @Test("The same last day is no change; another day is sent as its last second")
    func expiryDay() throws {
        let calendar = try moscow()
        // 19 Oct 2027, 14:32 Moscow.
        let current = try #require(calendar.date(from: DateComponents(year: 2027, month: 10, day: 19, hour: 14, minute: 32)))
        var draft = CertificateEditDraft(certificate(expiresAt: current), now: now, calendar: calendar)
        #expect(draft.expires)
        #expect(calendar.isDate(draft.lastDay, inSameDayAs: current))
        #expect(!draft.expiryChanged)

        draft.lastDay = try #require(calendar.date(from: DateComponents(year: 2027, month: 12, day: 31)))
        #expect(draft.expiryChanged)
        let sent = try encoded(draft.body)
        #expect(sent.keys.sorted() == ["expiresAt"])
        // 31 Dec 23:59:59 Moscow = 20:59:59 UTC.
        #expect(sent["expiresAt"] as? String == "2027-12-31T20:59:59.000Z")
    }

    @Test("«Бессрочно» is sent as null; a certificate without a term gets one a year ahead")
    func neverAndBack() throws {
        let calendar = try moscow()
        var limited = CertificateEditDraft(certificate(expiresAt: now.addingTimeInterval(86_400 * 30)), now: now, calendar: calendar)
        limited.expires = false
        #expect(try encoded(limited.body)["expiresAt"] is NSNull)

        var unlimited = CertificateEditDraft(certificate(expiresAt: nil), now: now, calendar: calendar)
        #expect(!unlimited.expires)
        let nextYear = try #require(calendar.date(byAdding: .year, value: 1, to: now))
        #expect(calendar.isDate(unlimited.lastDay, inSameDayAs: nextYear))
        unlimited.expires = true
        #expect(unlimited.expiryChanged)
        #expect(unlimited.canSave(now: now))
    }

    @Test("A last day already over cannot be saved; today still can")
    func pastDay() throws {
        let calendar = try moscow()
        var draft = CertificateEditDraft(certificate(expiresAt: nil), now: now, calendar: calendar)
        draft.expires = true
        draft.lastDay = try #require(calendar.date(byAdding: .day, value: -1, to: now))
        #expect(draft.issue(now: now)?.contains("в будущем") == true)
        draft.lastDay = now
        #expect(draft.issue(now: now) == nil)
        #expect(CertificateEditDraft.expiresAt(lastDay: now, calendar: calendar) > now)
    }

    @Test("The expiry can change while the certificate works or is spent, not once expired or cancelled")
    func expiryByStatus() {
        #expect(CertificateEditDraft.allowsExpiryChange(.active))
        #expect(CertificateEditDraft.allowsExpiryChange(.used))
        #expect(!CertificateEditDraft.allowsExpiryChange(.expired))
        #expect(!CertificateEditDraft.allowsExpiryChange(.cancelled))
        #expect(!CertificateEditDraft.allowsExpiryChange(.unknown))
    }

    @Test("Every role fixes the recipient and note; only the owner changes the expiry", arguments: [
        (EmployeeRole.owner, true), (.admin, false), (.master, false),
    ])
    func roles(role: EmployeeRole, changesExpiry: Bool) {
        let permissions = Permissions(role: role, employeeId: 1)
        #expect(permissions.editsCertificateDetails)
        #expect(permissions.changesCertificateExpiry == changesExpiry)
    }
}
