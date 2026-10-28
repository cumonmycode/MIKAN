import Foundation

/// Masters' portfolio (docs/API.md «Portfolio»). Every role may look at any master's photos.
nonisolated extension Permissions {
    /// Owner and admin add, edit, reorder and delete any master's photos (and browse every master in «Ещё»).
    var managesAllPortfolios: Bool { role != .master }

    /// A master manages only their own portfolio.
    func managesPortfolio(of employeeId: Int) -> Bool {
        managesAllPortfolios || employeeId == self.employeeId
    }
}
