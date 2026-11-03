import Foundation

// MARK: - Audit log

extension APIClient {
    /// A page of the audit log, newest first. Owner only: others get `403`.
    func auditLog(_ query: AuditQuery) async throws -> ItemsResponse<AuditEntry> {
        try await request(.get, "audit", query: query.parameters)
    }
}

/// `GET /audit` filters; the ones not set stay out of the URL.
nonisolated struct AuditQuery: Hashable, Sendable {
    static let defaultLimit = 50
    static let maxLimit = 200

    var from: Date?
    var to: Date?
    var employeeId: Int?
    /// Sent as one comma-separated `entity` (e.g. `appointment,deposit`); empty — every section.
    var sections: [AuditSection] = []
    var entityId: Int?
    var source: AuditSource?
    var limit = AuditQuery.defaultLimit
    var offset = 0

    var parameters: [URLQueryItem] {
        queryItems([
            "from": from.map { ISO8601.string(from: $0) },
            "to": to.map { ISO8601.string(from: $0) },
            "employeeId": employeeId.map(String.init),
            "entity": sections.isEmpty ? nil : sections.map(\.rawValue).joined(separator: ","),
            "entityId": entityId.map(String.init),
            "source": source?.rawValue,
            "limit": String(min(max(limit, 1), Self.maxLimit)),
            "offset": String(max(offset, 0)),
        ])
    }
}
