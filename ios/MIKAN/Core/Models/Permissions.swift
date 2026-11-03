import Foundation

/// What the signed-in employee may do (docs/API.md «Roles»). The server checks every request; the app only hides or
/// disables what the role can't use. Views read it with `@Environment(\.permissions)`.
nonisolated struct Permissions: Equatable, Sendable {
    let role: EmployeeRole
    /// The signed-in employee; `nil` — nobody yet.
    let employeeId: Int?

    init(role: EmployeeRole, employeeId: Int?) {
        self.role = role
        self.employeeId = employeeId
    }

    /// Without an employee the app shows only what every role may see.
    init(employee: Employee?) {
        self.init(role: employee?.role ?? .master, employeeId: employee?.id)
    }

    /// Create employees, edit others, roles and access.
    var managesEmployees: Bool { role == .owner }
    /// Services, products, categories, aftercare templates, stock movements, purchases, revisions, deliveries, image
    /// generation. Every role reads deliveries.
    var editsCatalog: Bool { role != .master }
    /// Reports and analytics.
    var seesReports: Bool { role != .master }
    /// Studio and bot settings, the knowledge base, staff chat binding and the bot test.
    var editsSettings: Bool { role != .master }

    /// Edit, move, cancel and take prepayments: owner and admin — any appointment, a master — their own.
    /// Completing a visit is a till action, open to every role (checkout, «Завершить»).
    func canChange(appointmentOf masterId: Int) -> Bool {
        role != .master || masterId == employeeId
    }

    func canChange(_ appointment: Appointment) -> Bool {
        canChange(appointmentOf: appointment.master.id)
    }

    /// The master of a new or edited appointment: a master books only themselves.
    func master(for proposed: Int?) -> Int? {
        role == .master ? employeeId : proposed
    }

    /// A master can't pick another master for an appointment.
    var picksMaster: Bool { role != .master }

    /// What of `employee`'s card may be changed; `nil` — a new employee.
    func editAccess(to employee: Employee?) -> EmployeeEditAccess {
        guard let employee else { return managesEmployees ? .everything : .nothing }
        if employee.id == employeeId {
            // Nobody changes their own role or turns off their own access.
            return EmployeeEditAccess(profile: true, account: managesEmployees, role: false, access: false)
        }
        return managesEmployees ? .everything : .nothing
    }
}

/// The parts of an employee card the signed-in employee may change.
nonisolated struct EmployeeEditAccess: Equatable, Sendable {
    /// Name, phone, color and password.
    let profile: Bool
    /// Login and «Мастер».
    let account: Bool
    let role: Bool
    /// «Доступ к приложению».
    let access: Bool

    static let everything = EmployeeEditAccess(profile: true, account: true, role: true, access: true)
    static let nothing = EmployeeEditAccess(profile: false, account: false, role: false, access: false)

    /// Opens the editor at all.
    var canEdit: Bool { profile || account || role || access }
}

nonisolated extension EmployeeRole {
    /// A short hint under the role picker.
    var abilities: String {
        switch self {
        case .owner:
            "Может всё: сотрудники и их роли, зарплаты, журнал действий, отчёты и настройки."
        case .admin:
            "Может всё, кроме управления сотрудниками, чужих зарплат и журнала действий."
        case .master:
            "Видит весь календарь, а меняет только свои записи. Касса и клиенты — полностью. Каталог, склад и настройки — только просмотр, без отчётов."
        }
    }
}
