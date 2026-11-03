import Foundation
import Testing
@testable import MIKAN

/// Sign-in sessions (docs/API.md «Sessions»): decoding, the owner's grouping, signing out everywhere and the
/// `X-Device` name sent on login.
struct SessionsTests {
    static let session = #"""
    { "id": 7, "employee": { "id": 2, "name": "Анна", "color": "#FF7A1A" }, "device": "iPhone 16 Pro · MIKAN 13",
      "ip": "95.170.124.192", "createdAt": "<T>", "lastSeenAt": "<T>", "current": true }
    """#

    private func session(
        id: Int, employee: Int, name: String, current: Bool = false, seen: TimeInterval = 0
    ) -> AuthSession {
        AuthSession(
            id: id, employee: EmployeeRef(id: employee, name: name, color: nil), device: "D\(id)", ip: nil,
            createdAt: Fixtures.referenceDate, lastSeenAt: Fixtures.referenceDate.addingTimeInterval(seen), current: current
        )
    }

    @Test("A session decodes as documented, with and without milliseconds", arguments: [true, false])
    func decodes(fractional: Bool) throws {
        let decoded = try Fixtures.decode(AuthSession.self, Self.session, fractional: fractional)
        #expect(decoded.id == 7)
        #expect(decoded.employee == EmployeeRef(id: 2, name: "Анна", color: "#FF7A1A"))
        #expect(decoded.device == "iPhone 16 Pro · MIKAN 13")
        #expect(decoded.ip == "95.170.124.192")
        #expect(decoded.createdAt == Fixtures.referenceDate)
        #expect(decoded.lastSeenAt == Fixtures.referenceDate)
        #expect(decoded.current)
        #expect(decoded.activityText() == "Это устройство")
    }

    @Test("Unknown device and ip are null; a missing `current` means another device")
    func decodesNulls() throws {
        let json = #"""
        { "items": [ { "id": 8, "employee": { "id": 3, "name": "Фатима", "color": null }, "device": null, "ip": null,
          "createdAt": "<T>", "lastSeenAt": "<T>" } ] }
        """#
        let list = try Fixtures.decode(ItemsResponse<AuthSession>.self, json)
        let only = try #require(list.items.first)
        #expect(only.deviceTitle == "Неизвестное устройство")
        #expect(!only.current)
        #expect(only.activityText().hasPrefix("Активность: "))
        #expect(!only.signInText.contains("·"))
    }

    @Test("The owner's list: own sessions first, then employees by name; this iPhone first within a group")
    func ownerGroups() {
        let list = [
            session(id: 1, employee: 3, name: "Фатима", seen: 10),
            session(id: 2, employee: 1, name: "Владелец", seen: 50),
            session(id: 3, employee: 2, name: "Анна", seen: 5),
            session(id: 4, employee: 1, name: "Владелец", current: true, seen: 0),
            session(id: 5, employee: 2, name: "Анна", seen: 20),
        ]
        let groups = SessionGrouping.groups(list, me: 1)
        #expect(groups.map(\.employee.name) == ["Владелец", "Анна", "Фатима"])
        #expect(groups[0].sessions.map(\.id) == [4, 2])
        #expect(groups[1].sessions.map(\.id) == [5, 3])
    }

    @Test("«Выйти на всех устройствах» ends the employee's other sessions only")
    func otherSessions() {
        let list = [
            session(id: 1, employee: 1, name: "Анна", current: true),
            session(id: 2, employee: 1, name: "Анна"),
            session(id: 3, employee: 2, name: "Фатима"),
            session(id: 4, employee: 1, name: "Анна"),
        ]
        #expect(SessionGrouping.otherSessionIds(list, employeeId: 1) == [2, 4])
        #expect(SessionGrouping.otherSessionIds([], employeeId: 1).isEmpty)
    }

    @Test("Login names the device «<model> · MIKAN <build>» in X-Device")
    @MainActor
    func deviceHeader() throws {
        #expect(DeviceName.header(model: "iPhone 16 Pro", build: "13") == "iPhone 16 Pro · MIKAN 13")
        #expect(DeviceName.marketingName(for: "iPhone17,1") == "iPhone 16 Pro")
        #expect(DeviceName.marketingName(for: "iPhone18,4") == "iPhone Air")
        #expect(DeviceName.marketingName(for: "iPhone99,9") == "iPhone99,9")
        #expect(DeviceName.current.contains(" · MIKAN "))

        let api = APIClient(serverURL: URL(string: "https://studio.example.ru")!)
        let request = try api.makeRequest(
            .post, "auth/login", query: [], body: Data("{}".utf8), contentType: "application/json", timeout: 20,
            headers: [DeviceName.headerField: "iPhone 16 Pro · MIKAN 13"]
        )
        #expect(request.value(forHTTPHeaderField: "X-Device") == "iPhone 16 Pro · MIKAN 13")
    }
}
