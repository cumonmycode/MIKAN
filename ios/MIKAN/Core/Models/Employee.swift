import Foundation

/// Staff member. `role` decides what they may do (docs/API.md «Roles»); `isMaster` marks people who perform procedures.
nonisolated struct Employee: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    var name: String
    var login: String
    var phone: String?
    var color: String?
    var isMaster: Bool
    var role: EmployeeRole = .admin
    var active: Bool
    let createdAt: Date

    var ref: EmployeeRef { EmployeeRef(id: id, name: name, color: color) }
}

nonisolated extension Employee {
    private enum CodingKeys: String, CodingKey {
        case id, name, login, phone, color, isMaster, role, active, createdAt
    }

    /// A server older than roles sends no `role`: treat everyone as `admin` (the old «all equal» behaviour).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        login = try c.decode(String.self, forKey: .login)
        phone = try c.decodeIfPresent(String.self, forKey: .phone)
        color = try c.decodeIfPresent(String.self, forKey: .color)
        isMaster = try c.decode(Bool.self, forKey: .isMaster)
        role = try c.decodeIfPresent(EmployeeRole.self, forKey: .role) ?? .admin
        active = try c.decode(Bool.self, forKey: .active)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
    }
}

/// What an employee may do. The server checks every request; the app only hides what the role can't use.
nonisolated enum EmployeeRole: String, Codable, CaseIterable, Hashable, Sendable {
    case owner, admin, master

    var title: String {
        switch self {
        case .owner: "Владелец"
        case .admin: "Администратор"
        case .master: "Мастер"
        }
    }
}

/// Embedded employee summary used inside other entities.
nonisolated struct EmployeeRef: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    let name: String
    let color: String?
}
