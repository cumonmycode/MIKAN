import Foundation
import Testing
@testable import MIKAN

/// Push notifications (docs/API.md «Push notifications»): a tapped notification opens the right screen, the device
/// token and its environment reach the server as documented.
struct PushRouteTests {
    @Test("Each event opens its screen (fields next to aps, ids as numbers)", arguments: [
        ("online_booking", PushRoute.appointment(id: 12)),
        ("deposit_paid", .appointment(id: 13)),
        ("client_cancelled", .appointment(id: 14)),
        ("client_message", .chat(chatId: 123_456_789_012)),
        ("booking_request", .bookingRequests),
    ])
    func routes(type: String, route: PushRoute) {
        var userInfo: [AnyHashable: Any] = ["aps": ["alert": ["title": "Новая онлайн-запись", "body": "Анна"]], "type": type]
        switch route {
        case .appointment(let id): userInfo["appointmentId"] = id
        case .chat(let chatId): userInfo["chatId"] = chatId
        case .bookingRequests: userInfo["bookingRequestId"] = 5
        case .onlineBookings: break
        }
        #expect(PushRoute(userInfo: userInfo) == route)
    }

    @Test("The event may sit in a data dictionary, and ids may come as strings")
    func nestedAndStringIds() {
        let nested: [AnyHashable: Any] = ["aps": ["sound": "default"], "data": ["type": "deposit_paid", "appointmentId": "21"]]
        #expect(PushRoute(userInfo: nested) == .appointment(id: 21))
        let chat: [AnyHashable: Any] = ["type": "client_message", "chatId": "-1001234567890"]
        #expect(PushRoute(userInfo: chat) == .chat(chatId: -1_001_234_567_890))
    }

    @Test("A new online booking without an id opens the list of online bookings")
    func onlineBookingWithoutId() {
        #expect(PushRoute(userInfo: ["type": "online_booking"]) == .onlineBookings)
    }

    @Test("Unknown events, missing or odd ids open nothing")
    func unroutable() {
        #expect(PushRoute(userInfo: [:]) == nil)
        #expect(PushRoute(userInfo: ["type": "shift_closed"]) == nil)
        #expect(PushRoute(userInfo: ["type": "deposit_paid"]) == nil)
        #expect(PushRoute(userInfo: ["type": "client_cancelled", "appointmentId": "двенадцать"]) == nil)
        #expect(PushRoute(userInfo: ["type": "client_message", "chatId": true]) == nil)
        #expect(PushRoute(userInfo: ["type": "deposit_paid", "appointmentId": 12.5]) == nil)
    }

    @Test("Routes are distinct sheets")
    func identities() {
        let ids = [PushRoute.appointment(id: 1), .chat(chatId: 1), .bookingRequests, .onlineBookings].map(\.id)
        #expect(Set(ids).count == ids.count)
    }
}

@MainActor
struct PushDeviceTests {
    @Test("The APNs token is sent as lowercase hex")
    func tokenHex() {
        #expect(PushCenter.hex(Data([0x00, 0x0f, 0xa0, 0xff])) == "000fa0ff")
        #expect(PushCenter.hex(Data()) == "")
    }

    @Test("Only a token the server accepts is sent: hex, 32–100 digits")
    func tokenFormat() {
        #expect(PushCenter.isValidToken(PushCenter.hex(Data(repeating: 0xab, count: 32))))
        #expect(PushCenter.isValidToken(String(repeating: "A", count: 100)))
        #expect(!PushCenter.isValidToken(String(repeating: "a", count: 31)))
        #expect(!PushCenter.isValidToken(String(repeating: "a", count: 101)))
        #expect(!PushCenter.isValidToken(String(repeating: "g", count: 64)))
    }

    @Test("POST /devices sends the token and the APNs environment")
    func deviceBody() throws {
        let data = try JSONCoding.makeEncoder().encode(DeviceBody(token: "ab01", environment: .sandbox))
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["token"] as? String == "ab01")
        #expect(json["environment"] as? String == "sandbox")
        #expect(PushEnvironment.production.rawValue == "production")
    }

    @Test("The environment follows the build configuration")
    func environment() {
        #if DEBUG
        #expect(PushEnvironment.current == .sandbox)
        #else
        #expect(PushEnvironment.current == .production)
        #endif
    }

    @Test("Only a signed-in session opens a notification's screen")
    func openRoute() throws {
        let api = APIClient(serverURL: try #require(URL(string: "https://mikan.invalid")))
        let signedIn = AppState(api: api, employee: nil, phase: .signedIn)
        signedIn.open(.appointment(id: 3))
        #expect(signedIn.pushRoute == .appointment(id: 3))
        signedIn.open(nil)
        #expect(signedIn.pushRoute == .appointment(id: 3), "an unknown event keeps what is open")

        let signedOut = AppState(api: api, employee: nil, phase: .signedOut)
        signedOut.open(.bookingRequests)
        #expect(signedOut.pushRoute == nil)
    }

    @Test("A notification for a session that has ended is not shown in the foreground")
    func foregroundAfterSignOut() throws {
        let api = APIClient(serverURL: try #require(URL(string: "https://mikan.invalid")))
        #expect(AppState(api: api, employee: nil, phase: .signedOut).foregroundPresentation().isEmpty)
    }
}
