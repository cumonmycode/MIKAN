import SwiftUI

@main
struct MIKANApp: App {
    /// Owns the app state, so push notifications reach it from launch on.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        // Service covers and work photos (AsyncImage → URLSession.shared) repeat across the catalog, POS grid and
        // cards; the server marks uploads immutable, so a larger shared cache avoids re-downloading them.
        URLCache.shared = URLCache(memoryCapacity: 64 * 1024 * 1024, diskCapacity: 256 * 1024 * 1024)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .appEnvironment(appDelegate.appState)
        }
    }
}

extension View {
    /// Injects the app state, its stores and the Russian locale/calendar.
    func appEnvironment(_ state: AppState) -> some View {
        modifier(PermissionsEnvironment(state: state))
            .environment(state)
            .environment(state.api)
            .environment(state.shift)
            .environment(state.cart)
            .environment(state.receipts)
            .environment(state.schedule)
            .environment(state.reference)
            .environment(state.workSchedules)
            .environment(state.lock)
            .environment(state.connectivity)
            .environment(\.locale, .app)
            .environment(\.calendar, .app)
    }
}
