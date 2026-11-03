import Foundation

/// A sign-in on a device (docs/API.md «Sessions»). `current` — the session of this iPhone.
nonisolated struct AuthSession: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let employee: EmployeeRef
    let device: String?
    let ip: String?
    let createdAt: Date
    let lastSeenAt: Date
    let current: Bool
}

nonisolated extension AuthSession {
    private enum CodingKeys: String, CodingKey {
        case id, employee, device, ip, createdAt, lastSeenAt, current
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        employee = try c.decode(EmployeeRef.self, forKey: .employee)
        device = try c.decodeIfPresent(String.self, forKey: .device)
        ip = try c.decodeIfPresent(String.self, forKey: .ip)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        lastSeenAt = try c.decode(Date.self, forKey: .lastSeenAt)
        current = try c.decodeIfPresent(Bool.self, forKey: .current) ?? false
    }

    /// «iPhone 16 Pro · MIKAN 13».
    var deviceTitle: String { device.nonEmpty ?? "Неизвестное устройство" }

    /// «Это устройство» or when it was last used.
    func activityText(now: Date = .now) -> String {
        current ? "Это устройство" : "Активность: \(DateText.relative(lastSeenAt, now: now))"
    }

    /// «Вход 15 окт., 11:00 · 95.170.124.192».
    var signInText: String {
        ["Вход \(DateText.dateTime(createdAt))", ip.nonEmpty].compactMap(\.self).joined(separator: " · ")
    }
}

/// Sessions of one employee in the owner's list.
nonisolated struct SessionGroup: Identifiable, Equatable, Sendable {
    let employee: EmployeeRef
    let sessions: [AuthSession]

    var id: Int { employee.id }
}

nonisolated enum SessionGrouping {
    /// By employee: your own first, then by name; within one, this iPhone first, then the most recently used.
    static func groups(_ sessions: [AuthSession], me: Int?) -> [SessionGroup] {
        let byEmployee = Dictionary(grouping: sessions, by: \.employee.id)
        let groups = byEmployee.values.compactMap { list -> SessionGroup? in
            guard let first = list.first else { return nil }
            let ordered = list.sorted { lhs, rhs in
                if lhs.current != rhs.current { return lhs.current }
                if lhs.lastSeenAt != rhs.lastSeenAt { return lhs.lastSeenAt > rhs.lastSeenAt }
                return lhs.id > rhs.id
            }
            return SessionGroup(employee: first.employee, sessions: ordered)
        }
        return groups.sorted { lhs, rhs in
            let lhsMine = lhs.employee.id == me
            let rhsMine = rhs.employee.id == me
            if lhsMine != rhsMine { return lhsMine }
            let order = lhs.employee.name.compare(rhs.employee.name, locale: .app)
            if order != .orderedSame { return order == .orderedAscending }
            return lhs.employee.id < rhs.employee.id
        }
    }

    /// «Выйти на всех устройствах»: the employee's sessions on other devices, ended before this one signs out.
    static func otherSessionIds(_ sessions: [AuthSession], employeeId: Int) -> [Int] {
        sessions.filter { $0.employee.id == employeeId && !$0.current }.map(\.id)
    }
}
