import Foundation
import Network
import Observation

/// Whether the server can be reached: the network path, and whether the latest request got an answer.
nonisolated struct ConnectivityState: Equatable, Sendable {
    var pathAvailable = true
    var serverReachable = true

    var isOnline: Bool { pathAvailable && serverReachable }
    /// Offline only because the server stopped answering: worth asking it again now and then.
    var needsProbe: Bool { pathAvailable && !serverReachable }

    /// A new path (Wi-Fi back, another network) is worth trying the server again.
    mutating func pathChanged(available: Bool) {
        if available, !pathAvailable { serverReachable = true }
        pathAvailable = available
    }

    /// Any answer from the server, even an error, means it is there.
    mutating func serverAnswered() {
        serverReachable = true
    }

    mutating func serverUnreachable() {
        serverReachable = false
    }
}

/// Network state for the offline mode (docs/API.md «Offline mode (app)»): `NWPathMonitor` plus how requests went.
/// Offline, screens show the phone's copy read-only, writes are refused before they are sent (`OfflineWriteGuard`),
/// and a banner tells how old the data is; getting back online bumps `reconnects`, which refreshes what is shown.
@Observable
final class Connectivity {
    private(set) var state: ConnectivityState
    /// When the data on screen was last heard from the server: the latest answer, or the newest saved copy.
    private(set) var dataAsOf: Date?
    /// Bumped each time the app gets back online.
    private(set) var reconnects = 0
    @ObservationIgnored private var monitor: NWPathMonitor?

    init(state: ConnectivityState = ConnectivityState()) {
        self.state = state
    }

    var isOnline: Bool { state.isOnline }
    /// Writes need the server: views disable their buttons on it, and `APIClient` refuses anything but a GET.
    var canWrite: Bool { state.isOnline }
    /// «Нет сети — данные на 14:32» while offline.
    var bannerText: String? {
        state.isOnline ? nil : OfflineBannerText.text(dataAsOf: dataAsOf)
    }

    /// Starts watching the network path (once).
    func start() {
        guard monitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = Self.pathHandler { [weak self] available in
            self?.pathChanged(available: available)
        }
        monitor.start(queue: DispatchQueue(label: "com.mikanstudio.crm.connectivity"))
        self.monitor = monitor
    }

    /// Built outside the main actor: the monitor calls it on its own queue.
    private nonisolated static func pathHandler(
        _ onChange: @escaping @MainActor @Sendable (Bool) -> Void
    ) -> @Sendable (NWPath) -> Void {
        { path in
            let available = path.status == .satisfied
            Task { @MainActor in onChange(available) }
        }
    }

    func pathChanged(available: Bool) {
        var next = state
        next.pathChanged(available: available)
        apply(next)
    }

    func serverAnswered(at date: Date = .now) {
        dataAsOf = date
        var next = state
        next.serverAnswered()
        apply(next)
    }

    func serverUnreachable() {
        var next = state
        next.serverUnreachable()
        apply(next)
    }

    /// The phone's copy was opened: until the server answers, the data is as old as the newest saved copy.
    func restored(savedAt: Date?) {
        if dataAsOf == nil { dataAsOf = savedAt }
    }

    /// Sign-out: nothing of the previous session's data is described any more.
    func reset() {
        dataAsOf = nil
    }

    private func apply(_ next: ConnectivityState) {
        guard next != state else { return }
        let wasOnline = state.isOnline
        state = next
        if !wasOnline, next.isOnline { reconnects += 1 }
    }
}

/// Writes need the server (docs/API.md «Offline mode (app)»): offline, every request but a GET is refused before it
/// is sent, with «Нужен интернет». Also tells which failures mean the server can't be reached.
nonisolated enum OfflineWriteGuard {
    /// Signing in is how the app gets online again, so it is always tried.
    static let alwaysSent: Set<String> = ["auth/login"]

    static func check(_ method: HTTPMethod, path: String, isOnline: Bool) throws {
        guard !isOnline, method != .get, !alwaysSent.contains(path) else { return }
        throw APIError.offline
    }

    /// The request got no answer: no network, or the server's host not found or not answering.
    static func isUnreachable(_ code: URLError.Code) -> Bool {
        switch code {
        case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff, .callIsActive,
             .networkConnectionLost, .timedOut, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
            true
        default:
            false
        }
    }

    /// A proxy's 502 / 503 / 504 page rather than the API's own error envelope: the server itself is down.
    static func isUnreachable(status: Int, body: Data) -> Bool {
        guard [502, 503, 504].contains(status) else { return false }
        return (try? JSONDecoder().decode(APIErrorEnvelope.self, from: body)) == nil
    }
}

/// The offline banner: «Нет сети — данные на 14:32».
nonisolated enum OfflineBannerText {
    static let title = "Нет сети"

    static func text(dataAsOf: Date?, now: Date = .now, calendar: Calendar = .app) -> String {
        guard let dataAsOf else { return title }
        return "\(title) — данные на \(stamp(dataAsOf, now: now, calendar: calendar))"
    }

    /// "14:32" today, "вчера, 14:32", otherwise "12 окт., 14:32".
    static func stamp(_ date: Date, now: Date, calendar: Calendar) -> String {
        let time = DateText.time(date)
        if calendar.isDate(date, inSameDayAs: now) { return time }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "вчера, \(time)"
        }
        return DateText.dateTime(date)
    }
}
