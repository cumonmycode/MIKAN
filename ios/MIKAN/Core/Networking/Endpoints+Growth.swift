import Foundation

// MARK: - Growth report

extension APIClient {
    /// How the studio grows over `[from, to)`: the booking funnel, master load, retention, client value and sources.
    func reportGrowth(from: Date, to: Date) async throws -> ReportGrowth {
        try await request(.get, "reports/growth", query: queryItems([
            "from": ISO8601.string(from: from),
            "to": ISO8601.string(from: to),
        ]))
    }
}
