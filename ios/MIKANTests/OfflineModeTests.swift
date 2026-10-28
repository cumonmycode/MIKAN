import Foundation
import Testing
@testable import MIKAN

/// Offline mode (docs/API.md «Offline mode (app)»): the copy kept on the phone, the schedule window, the write guard
/// and the banner.
enum OfflineFixtures {
    /// Tuesday 20 October 2026, 14:00 on the device clock.
    static let now = at(day: 20, hour: 14)

    static func at(month: Int = 10, day: Int, hour: Int, minute: Int = 0) -> Date {
        Calendar.app.date(from: DateComponents(year: 2026, month: month, day: day, hour: hour, minute: minute))!
    }

    static func appointment(id: Int, start: Date, minutes: Int = 60, masterId: Int = 2) -> Appointment {
        Appointment(
            id: id, client: ClientRef(id: 1, name: "Анна", lastName: "Смирнова", phone: "+79991234567", telegramLinked: true),
            master: EmployeeRef(id: masterId, name: "Фатима", color: "#FF7A1A"), service: nil, title: "Хеликс",
            startsAt: start, endsAt: start.addingTimeInterval(TimeInterval(minutes * 60)), status: .confirmed,
            price: 3000, deposit: 1000, notes: "Аллергия на никель", createdAt: Fixtures.referenceDate,
            updatedAt: Fixtures.referenceDate
        )
    }

    static func client(_ id: Int, _ name: String, lastName: String? = nil, phone: String? = nil, instagram: String? = nil) -> Client {
        Client(
            id: id, name: name, lastName: lastName, phone: phone, instagram: instagram, birthday: nil, notes: nil,
            source: nil, telegramLinked: false, telegramUsername: nil, botEnabled: true, archived: false,
            createdAt: Fixtures.referenceDate, updatedAt: Fixtures.referenceDate, stats: nil
        )
    }

    static func query(_ day: Date, _ scale: CalendarScale, masterId: Int? = nil) -> ScheduleQuery {
        ScheduleQuery(period: .containing(day, scale: scale), masterId: masterId)
    }

    static func snapshot(_ appointments: [Appointment], loadedAt: Date = now) -> ScheduleSnapshot {
        ScheduleSnapshot(window: ScheduleSnapshot.window(around: now), loadedAt: loadedAt, appointments: appointments)
    }

    static func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "offline-\(UUID().uuidString)", directoryHint: .isDirectory)
    }
}

// MARK: - The copy on the phone

struct OfflineCodingTests {
    @Test("A saved copy reads back with its payload, format version and save time")
    func roundTrip() throws {
        let snapshot = OfflineFixtures.snapshot([
            OfflineFixtures.appointment(id: 1, start: OfflineFixtures.at(day: 20, hour: 11)),
            OfflineFixtures.appointment(id: 2, start: OfflineFixtures.at(day: 22, hour: 15), masterId: 3),
        ])
        let data = try OfflineCoding.encode(snapshot, savedAt: Fixtures.referenceDate)

        let envelope = try #require(try OfflineCoding.decode(ScheduleSnapshot.self, from: data))

        #expect(envelope.payload == snapshot)
        #expect(envelope.version == OfflineCoding.currentVersion)
        #expect(envelope.savedAt == Fixtures.referenceDate)
        #expect(try OfflineCoding.savedAt(of: data) == Fixtures.referenceDate)
    }

    @Test("A copy written in another format version is ignored", arguments: [-1, 1])
    func versionMismatch(delta: Int) throws {
        let clients = ClientsSnapshot(items: [OfflineFixtures.client(1, "Иван")], total: 1)
        let data = try OfflineCoding.encode(clients, savedAt: Fixtures.referenceDate, version: OfflineCoding.currentVersion + delta)

        #expect(try OfflineCoding.decode(ClientsSnapshot.self, from: data) == nil)
        #expect(try OfflineCoding.savedAt(of: data) == nil)
    }

    @Test("An old copy whose payload no longer fits the model is skipped, not misread")
    func oldShapeIsSkipped() throws {
        let data = Data(#"{ "version": 0, "savedAt": "2026-10-15T11:00:00.000Z", "payload": { "rows": [1, 2] } }"#.utf8)

        #expect(try OfflineCoding.decode(ScheduleSnapshot.self, from: data) == nil)
    }

    @Test("A file that is not a saved copy at all fails to read")
    func garbageThrows() {
        #expect(throws: (any Error).self) { try OfflineCoding.decode(ClientsSnapshot.self, from: Data("[]".utf8)) }
    }
}

struct OfflineCacheTests {
    private let clients = ClientsSnapshot(items: [OfflineFixtures.client(1, "Иван")], total: 1)

    @Test("Nothing is written or read before the copy is opened (the app is still behind Face ID)")
    func closedUntilOpened() async {
        let cache = OfflineCache(directory: OfflineFixtures.temporaryDirectory())
        await cache.save(clients, as: .clients, at: Fixtures.referenceDate)
        #expect(await cache.load(ClientsSnapshot.self, .clients) == nil)

        #expect(await cache.open())
        #expect(await cache.load(ClientsSnapshot.self, .clients) == nil, "the save while closed was dropped")
        #expect(await cache.open() == false, "already open")
        await cache.wipe()
    }

    @Test("A saved copy reads back; sign-out wipes it, so the next employee starts empty")
    func saveLoadWipe() async {
        let cache = OfflineCache(directory: OfflineFixtures.temporaryDirectory())
        _ = await cache.open()
        await cache.save(clients, as: .clients, at: Fixtures.referenceDate)

        #expect(await cache.load(ClientsSnapshot.self, .clients)?.payload == clients)
        #expect(await cache.load(ClientsSnapshot.self, .clients)?.savedAt == Fixtures.referenceDate)
        #expect(await cache.newestSavedAt() == Fixtures.referenceDate)

        await cache.wipe()
        #expect(await cache.load(ClientsSnapshot.self, .clients) == nil, "closed")
        _ = await cache.open()
        #expect(await cache.load(ClientsSnapshot.self, .clients) == nil, "deleted")
        #expect(await cache.newestSavedAt() == nil)
    }

    @Test("An older answer arriving late never overwrites a newer copy")
    func olderSaveIsDropped() async {
        let cache = OfflineCache(directory: OfflineFixtures.temporaryDirectory())
        _ = await cache.open()
        let newer = ClientsSnapshot(items: [OfflineFixtures.client(2, "Мария")], total: 1)
        await cache.save(newer, as: .clients, at: Fixtures.referenceDate)
        await cache.save(clients, as: .clients, at: Fixtures.referenceDate.addingTimeInterval(-60))

        #expect(await cache.load(ClientsSnapshot.self, .clients)?.payload == newer)
        await cache.wipe()
    }

    @Test("Each dataset has its own file")
    func fileNames() {
        let names: [OfflineDataset] = [
            .schedule, .clients, .services(includeInactive: false), .services(includeInactive: true),
            .products(kind: .jewelry, includeInactive: false), .products(kind: .jewelry, includeInactive: true),
            .products(kind: .goods, includeInactive: true), .categories, .employees(includeInactive: true),
            .studioSettings, .botSettings,
        ]
        #expect(Set(names.map(\.fileName)).count == names.count)
    }
}

// MARK: - The schedule window

struct ScheduleSnapshotTests {
    @Test("The window runs from local midnight 7 days back to the end of the 7th day ahead")
    func window() {
        let window = ScheduleSnapshot.window(around: OfflineFixtures.now)

        #expect(window.start == OfflineFixtures.at(day: 13, hour: 0))
        #expect(window.end == OfflineFixtures.at(day: 28, hour: 0))
        #expect(window.duration >= 14 * 86_400)
    }

    @Test("Today's day, three days and week lie inside the window; the month only overlaps it")
    func coverage() {
        let snapshot = OfflineFixtures.snapshot([])
        let today = OfflineFixtures.now

        #expect(snapshot.covers(OfflineFixtures.query(today, .day)))
        #expect(snapshot.covers(OfflineFixtures.query(today, .threeDays)))
        #expect(snapshot.covers(OfflineFixtures.query(today, .week)))
        #expect(!snapshot.covers(OfflineFixtures.query(today, .month)))
        #expect(snapshot.overlaps(OfflineFixtures.query(today, .month)))
        #expect(!snapshot.overlaps(OfflineFixtures.query(OfflineFixtures.at(month: 11, day: 20, hour: 12), .week)))
    }

    @Test("Appointments outside the window are not kept; a page shows its own range and master")
    func pages() throws {
        let inside = OfflineFixtures.appointment(id: 1, start: OfflineFixtures.at(day: 20, hour: 11))
        let otherMaster = OfflineFixtures.appointment(id: 2, start: OfflineFixtures.at(day: 20, hour: 16), masterId: 3)
        let laterInWeek = OfflineFixtures.appointment(id: 3, start: OfflineFixtures.at(day: 23, hour: 12))
        let tooEarly = OfflineFixtures.appointment(id: 4, start: OfflineFixtures.at(day: 12, hour: 12))
        let tooLate = OfflineFixtures.appointment(id: 5, start: OfflineFixtures.at(day: 28, hour: 10))
        let snapshot = OfflineFixtures.snapshot([laterInWeek, tooLate, inside, tooEarly, otherMaster])

        #expect(snapshot.appointments.map(\.id) == [1, 2, 3])
        let day = try #require(snapshot.appointments(for: OfflineFixtures.query(OfflineFixtures.now, .day)))
        #expect(day.map(\.id) == [1, 2])
        let mine = try #require(snapshot.appointments(for: OfflineFixtures.query(OfflineFixtures.now, .week, masterId: 2)))
        #expect(mine.map(\.id) == [1, 3])
        #expect(snapshot.appointments(for: OfflineFixtures.query(OfflineFixtures.at(month: 11, day: 20, hour: 12), .day)) == nil)
        #expect(snapshot.appointment(id: 3) == laterInWeek)
    }

    @Test("A loaded page replaces its range in the copy: changes come in, deletions go, other masters stay")
    func merging() {
        let morning = OfflineFixtures.appointment(id: 1, start: OfflineFixtures.at(day: 20, hour: 11))
        let deleted = OfflineFixtures.appointment(id: 2, start: OfflineFixtures.at(day: 20, hour: 13))
        let otherMaster = OfflineFixtures.appointment(id: 3, start: OfflineFixtures.at(day: 20, hour: 16), masterId: 3)
        let tomorrow = OfflineFixtures.appointment(id: 4, start: OfflineFixtures.at(day: 21, hour: 12))
        let snapshot = OfflineFixtures.snapshot([morning, deleted, otherMaster, tomorrow])
        var moved = morning
        moved.startsAt = OfflineFixtures.at(day: 20, hour: 18)
        moved.endsAt = OfflineFixtures.at(day: 20, hour: 19)

        let merged = snapshot.merging([moved], for: OfflineFixtures.query(OfflineFixtures.now, .day, masterId: 2))

        #expect(merged.appointments.map(\.id) == [3, 1, 4])
        #expect(merged.appointment(id: 1)?.startsAt == OfflineFixtures.at(day: 20, hour: 18))
        #expect(merged.loadedAt == snapshot.loadedAt, "a page does not count as loading the whole window")
        let outside = snapshot.merging([], for: OfflineFixtures.query(OfflineFixtures.at(month: 11, day: 20, hour: 12), .week))
        #expect(outside == snapshot)
    }

    @Test("An appointment saved in the app is updated in the copy, and leaves it when moved out of the window")
    func upserting() {
        let appointment = OfflineFixtures.appointment(id: 1, start: OfflineFixtures.at(day: 20, hour: 11))
        let snapshot = OfflineFixtures.snapshot([appointment])
        var renamed = appointment
        renamed.title = "Мочка"
        var moved = appointment
        moved.startsAt = OfflineFixtures.at(month: 11, day: 20, hour: 11)
        moved.endsAt = OfflineFixtures.at(month: 11, day: 20, hour: 12)

        #expect(snapshot.upserting(renamed).appointment(id: 1)?.title == "Мочка")
        #expect(snapshot.upserting(moved).appointments.isEmpty)
    }

    @Test("The whole window is loaded again after five minutes or on another day")
    func staleness() {
        let snapshot = OfflineFixtures.snapshot([])
        let maxAge = ScheduleStore.offlineWindowMaxAge

        #expect(!snapshot.isStale(now: OfflineFixtures.now.addingTimeInterval(60), maxAge: maxAge))
        #expect(snapshot.isStale(now: OfflineFixtures.now.addingTimeInterval(maxAge + 1), maxAge: maxAge))
        let older = OfflineFixtures.snapshot([], loadedAt: OfflineFixtures.at(day: 20, hour: 23, minute: 58))
        #expect(older.isStale(now: OfflineFixtures.at(day: 21, hour: 0, minute: 1), maxAge: maxAge), "the window moved on")
    }

    @Test("Offline, a page only partly inside the window says which days it shows")
    func coverageNote() {
        let snapshot = OfflineFixtures.snapshot([])
        let note = "Без сети видны записи только с \(DateText.dayMonth(OfflineFixtures.at(day: 13, hour: 0))) "
            + "по \(DateText.dayMonth(OfflineFixtures.at(day: 27, hour: 0)))"

        #expect(snapshot.coverageNote(for: OfflineFixtures.query(OfflineFixtures.now, .month)) == note)
        #expect(snapshot.coverageNote(for: OfflineFixtures.query(OfflineFixtures.now, .week)) == nil)
        #expect(snapshot.coverageNote(for: OfflineFixtures.query(OfflineFixtures.at(month: 11, day: 20, hour: 12), .week)) == nil)
    }
}

// MARK: - The client list

struct ClientsSnapshotTests {
    private let ivan = OfflineFixtures.client(1, "Иван", lastName: "Петров", phone: "+7 999 123-45-67", instagram: "ivan.p")
    private let maria = OfflineFixtures.client(2, "Мария", lastName: "Соколова", phone: "+79990001122")
    private let anna = OfflineFixtures.client(3, "Анна")

    @Test("The first page starts the copy again; further pages are added without repeats")
    func pages() {
        let first = ClientsSnapshot.saving([ivan, maria], offset: 0, total: 3, into: ClientsSnapshot(items: [anna], total: 9))
        #expect(first.items.map(\.id) == [1, 2])

        let second = ClientsSnapshot.saving([maria, anna], offset: 2, total: 3, into: first)
        #expect(second.items.map(\.id) == [1, 2, 3])
        #expect(second.total == 3)
    }

    @Test("Offline the saved list is searched on the phone by name, handle or phone digits")
    func search() {
        let snapshot = ClientsSnapshot(items: [ivan, maria, anna], total: 3)

        #expect(snapshot.page(search: "", limit: 50, offset: 0).items.map(\.id) == [1, 2, 3])
        #expect(snapshot.page(search: "  ПЕТРОВ ", limit: 50, offset: 0).items.map(\.id) == [1])
        #expect(snapshot.page(search: "иван петров", limit: 50, offset: 0).items.map(\.id) == [1])
        #expect(snapshot.page(search: "ivan.p", limit: 50, offset: 0).items.map(\.id) == [1])
        #expect(snapshot.page(search: "123-45", limit: 50, offset: 0).items.map(\.id) == [1])
        #expect(snapshot.page(search: "12", limit: 50, offset: 0).items.isEmpty, "two digits are too few for a phone")
        let page = snapshot.page(search: "", limit: 2, offset: 2)
        #expect(page.items.map(\.id) == [3])
        #expect(page.total == 3)
    }
}

// MARK: - Writes need the network

@MainActor
struct OfflineWriteGuardTests {
    @Test("Offline every request but a GET is refused before it is sent", arguments: [HTTPMethod.post, .patch, .put, .delete])
    func refusesWrites(method: HTTPMethod) {
        #expect(throws: APIError.offline) { try OfflineWriteGuard.check(method, path: "clients", isOnline: false) }
        #expect(throws: Never.self) { try OfflineWriteGuard.check(method, path: "clients", isOnline: true) }
    }

    @Test("Reads are always tried, and so is signing in")
    func readsAndLogin() {
        #expect(throws: Never.self) { try OfflineWriteGuard.check(.get, path: "clients", isOnline: false) }
        #expect(throws: Never.self) { try OfflineWriteGuard.check(.post, path: "auth/login", isOnline: false) }
    }

    @Test("The refusal is a friendly «Нужен интернет», not a network error")
    func message() {
        #expect(APIError.offline.message.hasPrefix("Нужен интернет"))
        #expect(!APIError.offline.isOutcomeUnknown)
    }

    @Test("The API client answers a write offline without sending it")
    func clientRefusesUnsent() async throws {
        let api = APIClient(serverURL: try #require(URL(string: "https://studio.invalid")))
        let connectivity = Connectivity(state: ConnectivityState(pathAvailable: false, serverReachable: true))
        api.connectivity = connectivity

        await #expect(throws: APIError.offline) { try await api.requestVoid(.delete, "clients/1") }
        #expect(!connectivity.canWrite)
    }

    @Test("No network, no host or a silent server count as unreachable; a bad certificate does not")
    func unreachable() {
        for code: URLError.Code in [.notConnectedToInternet, .timedOut, .cannotConnectToHost, .cannotFindHost, .networkConnectionLost] {
            #expect(OfflineWriteGuard.isUnreachable(code), "\(code)")
        }
        for code: URLError.Code in [.badURL, .secureConnectionFailed, .cancelled] {
            #expect(!OfflineWriteGuard.isUnreachable(code), "\(code)")
        }
        let envelope = Data(#"{ "error": { "code": "unavailable", "message": "ИИ недоступен" } }"#.utf8)
        #expect(OfflineWriteGuard.isUnreachable(status: 502, body: Data("<html>Bad Gateway</html>".utf8)))
        #expect(!OfflineWriteGuard.isUnreachable(status: 503, body: envelope), "the API's own answer")
        #expect(!OfflineWriteGuard.isUnreachable(status: 500, body: Data()))
    }

    @Test("Losing the network or the server goes offline; getting back counts a reconnect")
    func transitions() {
        let connectivity = Connectivity()
        #expect(connectivity.isOnline)

        connectivity.pathChanged(available: false)
        #expect(!connectivity.isOnline && !connectivity.canWrite)
        #expect(!connectivity.state.needsProbe, "nothing to ask without a network")
        connectivity.pathChanged(available: true)
        #expect(connectivity.isOnline)
        #expect(connectivity.reconnects == 1)

        connectivity.serverUnreachable()
        #expect(!connectivity.isOnline)
        #expect(connectivity.state.needsProbe)
        connectivity.serverAnswered(at: OfflineFixtures.now)
        #expect(connectivity.isOnline)
        #expect(connectivity.reconnects == 2)
        #expect(connectivity.dataAsOf == OfflineFixtures.now)
    }
}

// MARK: - The banner

@MainActor
struct OfflineBannerTests {
    @Test("«Нет сети — данные на 14:32» for data from today")
    func today() {
        let text = OfflineBannerText.text(
            dataAsOf: OfflineFixtures.at(day: 20, hour: 14, minute: 32), now: OfflineFixtures.at(day: 20, hour: 15, minute: 10)
        )
        #expect(text == "Нет сети — данные на 14:32")
    }

    @Test("Older data names the day")
    func olderData() {
        let now = OfflineFixtures.at(day: 20, hour: 9)
        let yesterday = OfflineFixtures.at(day: 19, hour: 21, minute: 5)
        let earlier = OfflineFixtures.at(day: 12, hour: 14, minute: 32)

        #expect(OfflineBannerText.text(dataAsOf: yesterday, now: now) == "Нет сети — данные на вчера, 21:05")
        #expect(OfflineBannerText.text(dataAsOf: earlier, now: now) == "Нет сети — данные на \(DateText.dateTime(earlier))")
    }

    @Test("Without any saved data the banner only says there is no network; online there is none")
    func edges() {
        #expect(OfflineBannerText.text(dataAsOf: nil) == "Нет сети")

        let connectivity = Connectivity()
        connectivity.serverAnswered(at: OfflineFixtures.at(day: 20, hour: 14, minute: 32))
        #expect(connectivity.bannerText == nil)
        connectivity.pathChanged(available: false)
        #expect(connectivity.bannerText?.hasPrefix("Нет сети — данные на ") == true)
    }

    @Test("The newest saved copy dates the data until the server answers")
    func restoredDate() {
        let connectivity = Connectivity()
        connectivity.restored(savedAt: Fixtures.referenceDate)
        #expect(connectivity.dataAsOf == Fixtures.referenceDate)
        connectivity.restored(savedAt: OfflineFixtures.now)
        #expect(connectivity.dataAsOf == Fixtures.referenceDate, "a session's own answer or first copy wins")
        connectivity.reset()
        #expect(connectivity.dataAsOf == nil)
    }
}
