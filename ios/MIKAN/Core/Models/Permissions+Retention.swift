import Foundation

/// Client retention (docs/API.md «Campaigns», «Retention settings»).
nonisolated extension Permissions {
    /// Telegram campaigns: owner and admin; a master does not see them at all.
    var runsCampaigns: Bool { role != .master }
    /// Loyalty, birthday, win-back and certificate settings: owner and admin change them, a master only looks.
    var editsRetention: Bool { editsSettings }
}
