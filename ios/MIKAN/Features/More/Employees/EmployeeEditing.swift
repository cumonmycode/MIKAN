import Foundation

nonisolated extension EmployeeBody {
    /// The editor's fields, limited to what `access` lets the signed-in employee change: login, «Мастер», the role
    /// and access are left out otherwise (the server refuses them, docs/API.md «Employees»).
    static func make(
        name: String,
        login: String,
        password: String?,
        phone: String?,
        color: String,
        isMaster: Bool,
        role: EmployeeRole,
        active: Bool,
        isCreating: Bool,
        access: EmployeeEditAccess
    ) -> EmployeeBody {
        EmployeeBody(
            name: name,
            login: access.account ? login : nil,
            password: password,
            phone: Nullable(phone),
            color: Nullable(color),
            isMaster: access.account ? isMaster : nil,
            role: access.role ? role : nil,
            // A new employee is always active.
            active: !isCreating && access.access ? active : nil
        )
    }
}

nonisolated extension EmployeeRole {
    /// The role a new employee starts with, as the server defaults it.
    static func defaultFor(isMaster: Bool) -> EmployeeRole {
        isMaster ? .master : .admin
    }
}
