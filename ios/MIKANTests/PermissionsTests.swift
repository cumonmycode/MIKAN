import Foundation
import Testing
@testable import MIKAN

/// Roles (docs/API.md «Roles»): what the app hides or locks for each one.
@MainActor
struct PermissionsTests {
    private func employee(_ id: Int, _ role: EmployeeRole, isMaster: Bool = true) -> Employee {
        Employee(id: id, name: "Сотрудник \(id)", login: "e\(id)", phone: nil, color: nil, isMaster: isMaster, role: role, active: true, createdAt: .distantPast)
    }

    private func permissions(_ role: EmployeeRole, id: Int = 1) -> Permissions {
        Permissions(employee: employee(id, role))
    }

    private func json(_ body: EmployeeBody) throws -> [String: Any] {
        let data = try JSONCoding.makeEncoder().encode(body)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("Owner and admin edit the catalog, settings and see reports; a master does not")
    func areas() {
        for role in [EmployeeRole.owner, .admin] {
            let p = permissions(role)
            #expect(p.editsCatalog && p.editsSettings && p.seesReports && p.picksMaster)
        }
        let master = permissions(.master)
        #expect(!master.editsCatalog && !master.editsSettings && !master.seesReports && !master.picksMaster)
        #expect(permissions(.owner).managesEmployees)
        #expect(!permissions(.admin).managesEmployees)
        #expect(!master.managesEmployees)
    }

    @Test("Without an employee the app shows only what every role may")
    func signedOut() {
        let nobody = Permissions(employee: nil)
        #expect(nobody.role == .master)
        #expect(!nobody.editsCatalog && !nobody.managesEmployees)
        #expect(!nobody.canChange(appointmentOf: 1))
    }

    @Test("A master changes only their own appointments; owner and admin any")
    func appointments() throws {
        #expect(permissions(.master, id: 3).canChange(appointmentOf: 3))
        #expect(!permissions(.master, id: 3).canChange(appointmentOf: 4))
        #expect(permissions(.admin, id: 3).canChange(appointmentOf: 4))
        #expect(permissions(.owner, id: 3).canChange(appointmentOf: 4))

        let appointment = try Fixtures.decode(Appointment.self, Fixtures.appointment) // master id 2
        #expect(permissions(.master, id: 2).canChange(appointment))
        #expect(!permissions(.master, id: 5).canChange(appointment))
        #expect(permissions(.admin, id: 5).canChange(appointment))
    }

    @Test("A new appointment of a master is locked to them; others keep the proposed master")
    func masterLock() {
        #expect(permissions(.master, id: 3).master(for: 7) == 3)
        #expect(permissions(.master, id: 3).master(for: nil) == 3)
        #expect(permissions(.admin, id: 3).master(for: 7) == 7)
        #expect(permissions(.owner, id: 3).master(for: nil) == nil)
    }

    @Test("Employee cards: the owner edits others fully; everyone edits only their own profile")
    func employeeCards() {
        let owner = permissions(.owner, id: 1)
        #expect(owner.editAccess(to: nil) == .everything)
        #expect(owner.editAccess(to: employee(2, .master)) == .everything)
        #expect(owner.editAccess(to: employee(1, .owner)) == EmployeeEditAccess(profile: true, account: true, role: false, access: false))

        for role in [EmployeeRole.admin, .master] {
            let p = permissions(role, id: 5)
            #expect(p.editAccess(to: nil) == .nothing)
            #expect(!p.editAccess(to: employee(6, .master)).canEdit)
            #expect(p.editAccess(to: employee(5, role)) == EmployeeEditAccess(profile: true, account: false, role: false, access: false))
            #expect(p.editAccess(to: employee(5, role)).canEdit)
        }
    }

    @Test("The saved card sends only what the employee may change")
    func employeeBody() throws {
        func body(access: EmployeeEditAccess, isCreating: Bool = false) throws -> [String: Any] {
            try json(.make(
                name: "Фатима", login: "fatima", password: nil, phone: nil, color: "#FF7A1A",
                isMaster: true, role: .master, active: true, isCreating: isCreating, access: access
            ))
        }

        let own = try body(access: EmployeeEditAccess(profile: true, account: false, role: false, access: false))
        #expect(Set(own.keys) == ["name", "phone", "color"])
        #expect(own["phone"] is NSNull)

        let other = try body(access: .everything)
        #expect(Set(other.keys) == ["name", "login", "phone", "color", "isMaster", "role", "active"])
        #expect(other["role"] as? String == "master")

        let new = try body(access: .everything, isCreating: true)
        #expect(Set(new.keys) == ["name", "login", "phone", "color", "isMaster", "role"])

        let ownerSelf = try body(access: EmployeeEditAccess(profile: true, account: true, role: false, access: false))
        #expect(Set(ownerSelf.keys) == ["name", "login", "phone", "color", "isMaster"])
    }

    @Test("A new employee's role follows «Мастер» like the server's default")
    func defaultRole() {
        #expect(EmployeeRole.defaultFor(isMaster: true) == .master)
        #expect(EmployeeRole.defaultFor(isMaster: false) == .admin)
        #expect(EmployeeRole.allCases.allSatisfy { !$0.abilities.isEmpty })
    }

    @Test("A 403 shows the server's message")
    func forbiddenMessage() {
        let body = Data(#"{ "error": { "code": "forbidden", "message": "Можно менять только свои записи" } }"#.utf8)
        let error = APIError.from(status: 403, data: body)
        #expect(error.code == "forbidden")
        #expect(error.userMessage == "Можно менять только свои записи")
        #expect(!error.isUnauthorized)
    }
}
