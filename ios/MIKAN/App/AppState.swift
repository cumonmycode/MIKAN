import Foundation
import Observation
import os

enum AppTab: Hashable {
    case schedule
    case clients
    case pos
    case inventory
    case more
}

/// Session, badges, tab selection and the app-wide stores.
@Observable
final class AppState {
    enum Phase: Equatable {
        case signedOut
        case signedIn
    }

    static let badgePollInterval: Duration = .seconds(30)

    let api: APIClient
    let shift: ShiftStore
    let cart: CartStore
    /// Open receipts of all devices; saves the cart's one.
    let receipts: OpenReceiptsStore
    let schedule: ScheduleStore
    let reference: ReferenceStore
    /// Masters' working time for the calendar.
    let workSchedules: WorkScheduleStore
    /// Push notifications: permission, the device token and its registration.
    let push: PushCenter
    /// The Face ID lock over the signed-in app.
    let lock: AppLock
    /// Network state of the offline mode (`AppState+Offline`).
    let connectivity: Connectivity
    /// The phone's copy of the main data for working offline.
    let offlineCache: OfflineCache

    private(set) var phase: Phase
    private(set) var employee: Employee?
    private(set) var badges = Badges.zero
    var selectedTab: AppTab = .schedule
    /// Navigation inside «Касса» (sales and shift history).
    var posPath: [POSRoute] = []
    /// The cart's receipt is on screen (`ReceiptFlowView`): alerts about it show there, not over the tabs.
    var isReceiptOpen = false
    /// Shown on the login screen after a forced sign-out.
    var signOutNotice: String?
    /// The screen of a tapped push notification, shown over the tabs.
    var pushRoute: PushRoute?

    @ObservationIgnored private let logger = Logger(subsystem: "com.mikanstudio.crm", category: "session")

    init(
        api: APIClient, employee: Employee?, phase: Phase, push: PushCenter = PushCenter(), lock: AppLock = AppLock(),
        connectivity: Connectivity = Connectivity(), offlineCache: OfflineCache = OfflineCache()
    ) {
        self.api = api
        self.push = push
        self.lock = lock
        self.connectivity = connectivity
        self.offlineCache = offlineCache
        api.connectivity = connectivity
        api.offlineCache = offlineCache
        self.shift = ShiftStore(api: api)
        let cart = CartStore()
        self.cart = cart
        self.receipts = OpenReceiptsStore(api: api, cart: cart)
        self.schedule = ScheduleStore(api: api)
        self.reference = ReferenceStore(api: api)
        self.workSchedules = WorkScheduleStore(api: api)
        self.employee = employee
        self.phase = phase
        api.onUnauthorized = { [weak self] in
            self?.handleUnauthorized()
        }
    }

    /// Restores the persisted session (token from the Keychain, server from UserDefaults).
    static func live() -> AppState {
        let token = Keychain.string(for: Keychain.tokenAccount)
        let api = APIClient(serverURL: ServerConfig.url, token: token)
        return AppState(
            api: api, employee: SessionCache.employee, phase: token == nil ? .signedOut : .signedIn,
            lock: AppLock(signedInAtLaunch: token != nil)
        )
    }

    /// «Ещё» tab badge.
    var moreBadge: Int { badges.moreTab }

    func signIn(login: String, password: String, server: String) async throws {
        guard let url = ServerConfig.normalize(server) else { throw APIError.invalidServerAddress }
        api.updateServer(url)
        let response = try await api.login(login.trimmed, password: password)
        ServerConfig.save(url)
        // Nothing saved by a previous session on this phone is shown to the new one.
        await offlineCache.wipe()
        Keychain.set(response.token, for: Keychain.tokenAccount)
        api.updateToken(response.token)
        employee = response.employee
        SessionCache.employee = response.employee
        signOutNotice = nil
        selectedTab = .schedule
        phase = .signedIn
    }

    func signOut(notice: String? = nil) {
        // While the session token still works: this iPhone stops getting the employee's notifications and the
        // session ends on the server.
        endServerSession()
        pushRoute = nil
        Keychain.set(nil, for: Keychain.tokenAccount)
        api.updateToken(nil)
        employee = nil
        SessionCache.employee = nil
        badges = .zero
        receipts.reset()
        cart.clear()
        posPath = []
        shift.reset()
        schedule.reset()
        reference.reset()
        workSchedules.reset()
        clearOfflineData()
        signOutNotice = notice
        phase = .signedOut
    }

    private func handleUnauthorized() {
        guard phase == .signedIn, !isReauthenticating else { return }
        signOut(notice: "Сессия завершена. Войдите снова.")
    }

    @ObservationIgnored private var isReauthenticating = false

    /// The server revokes all tokens of an employee whose password changed.
    /// After changing your own password, sign in again with the new one (or sign out with a clear message).
    func reauthenticate(login: String, password: String) async {
        isReauthenticating = true
        defer { isReauthenticating = false }
        do {
            let response = try await api.login(login, password: password)
            Keychain.set(response.token, for: Keychain.tokenAccount)
            api.updateToken(response.token)
            employee = response.employee
            SessionCache.employee = response.employee
        } catch {
            signOut(notice: "Пароль изменён. Войдите с новым паролем.")
        }
    }

    /// Refreshes the current employee (also validates the token).
    func refreshSession() async {
        do {
            let current = try await api.me()
            employee = current
            SessionCache.employee = current
        } catch is CancellationError {
            return
        } catch {
            logger.notice("Session refresh failed: \(error.userMessage, privacy: .public)")
        }
    }

    func refreshBadges() async {
        do {
            badges = try await api.badges()
        } catch is CancellationError {
            return
        } catch {
            logger.notice("Badges refresh failed: \(error.userMessage, privacy: .public)")
        }
    }

    /// Polls badges and the cash shift while the app is active (cancelled with the calling task); also retries
    /// registering this iPhone for push notifications until the server has it (a no-op once it has).
    func runPolling() async {
        while !Task.isCancelled, phase == .signedIn {
            async let badgesRefresh: Void = refreshBadges()
            async let shiftRefresh: Void = shift.refresh()
            async let pushRegistration: Void = registerPushDevice()
            _ = await (badgesRefresh, shiftRefresh, pushRegistration)
            try? await Task.sleep(for: Self.badgePollInterval)
        }
    }

    /// «Начать визит», «Открыть чек» or «Принять оплату» for an appointment: its open receipt — with the services,
    /// client and prepayment, or the one another device already opened — goes into the cart. The caller then shows it
    /// (`receiptFlow`), right where the cashier is; jewelry can still be added before paying.
    func startCheckout(for appointment: Appointment) async throws {
        let receipt = try await receipts.startVisit(appointment)
        if var started = receipt.appointment {
            started.receiptId = receipt.id
            schedule.upsert(started)
        }
    }

    /// «Продать» in the client card: a new receipt for the client in the cart (the caller shows it).
    func startSale(for client: ClientRef) async throws {
        try await receipts.openNew(for: client)
    }

    /// Deletes an open receipt; its appointment, if any, is back among the unpaid ones in the schedule.
    func deleteReceipt(id: Int, hasAppointment: Bool) async throws {
        try await receipts.delete(id: id)
        if hasAppointment { await schedule.refreshVisible() }
    }

    /// Cancelling an appointment or marking a no-show deletes its open receipt on the server: the cart lets it go
    /// (a receipt on screen then closes by itself).
    func appointmentClosed(_ appointment: Appointment) {
        guard !appointment.isActive else { return }
        receipts.forgetReceipt(ofAppointment: appointment.id)
    }
}
