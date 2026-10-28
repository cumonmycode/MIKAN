import Testing
@testable import MIKAN

/// The «Ещё» tab badge sums the badges of its rows (docs/API.md «Badges & dashboard»).
@MainActor
struct MoreTabBadgeTests {
    @Test("Chats, requests, online bookings and the waitlist count; low stock belongs to «Склад»")
    func sums() {
        let badges = Badges(
            unreadChats: 2, needsAttention: 1, newBookingRequests: 1, lowStock: 3, onlineAwaiting: 2, waitlist: 4
        )
        #expect(badges.moreTab == 9)
        #expect(Badges.zero.moreTab == 0)
        let waitlistOnly = Badges(unreadChats: 0, needsAttention: 0, newBookingRequests: 0, lowStock: 5, waitlist: 1)
        #expect(waitlistOnly.moreTab == 1)
    }
}
