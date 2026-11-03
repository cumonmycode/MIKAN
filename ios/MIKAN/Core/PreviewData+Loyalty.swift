#if DEBUG
import Foundation

/// Sample bonuses and gift certificates for SwiftUI previews only.
extension PreviewData {
    static let certificate = GiftCertificate(
        id: 1, code: "MIKAN-7K3Q-9F2D", amount: 5_000, balance: 3_000, status: .active,
        expiresAt: Calendar.app.date(byAdding: .year, value: 1, to: today), buyer: ivanRef, recipientName: "Маше",
        note: nil, saleId: 9, saleNumber: 17,
        operations: [
            GiftCertificateOperation(type: .issue, amount: 5_000, saleId: 9, saleNumber: 17, createdAt: now),
            GiftCertificateOperation(type: .redeem, amount: -2_000, saleId: 12, saleNumber: 21, createdAt: now),
        ],
        createdAt: now
    )

    static let usedCertificate = GiftCertificate(
        id: 2, code: "MIKAN-H4WP-2XRT", amount: 3_000, balance: 0, status: .used, expiresAt: nil, buyer: nil,
        recipientName: nil, note: nil, saleId: 7, saleNumber: 11, createdAt: now
    )

    static let loyalty = ClientLoyalty(
        bonusBalance: 1_200,
        expiring: BonusExpiring(amount: 500, at: Calendar.app.date(byAdding: .day, value: 14, to: today) ?? today),
        birthdayDiscount: BirthdayDiscount(percent: 10, until: CalendarDay.string(from: today))
    )

    static let bonusOperations = [
        BonusOperation(
            id: 3, type: .spend, amount: -300, remaining: nil, expiresAt: nil, saleId: 12, saleNumber: 21, note: nil,
            employee: anna.ref, createdAt: now
        ),
        BonusOperation(
            id: 2, type: .gift, amount: 500, remaining: 500, expiresAt: loyalty.expiring?.at, saleId: nil,
            saleNumber: nil, note: "С днём рождения", employee: nil, createdAt: now
        ),
        BonusOperation(
            id: 1, type: .earn, amount: 1_000, remaining: 700, expiresAt: nil, saleId: 9, saleNumber: 17, note: nil,
            employee: anna.ref, createdAt: now
        ),
    ]
}
#endif
