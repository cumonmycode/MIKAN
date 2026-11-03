import SwiftUI

struct RootView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.scenePhase) private var scenePhase

    private var isPolling: Bool { appState.phase == .signedIn && scenePhase == .active }

    var body: some View {
        ZStack {
            switch appState.phase {
            case .signedOut:
                LoginView()
                    .transition(.opacity)
            case .signedIn:
                MainTabView()
                    .transition(.opacity)
            }
        }
        .animation(.smooth(duration: 0.35), value: appState.phase)
        .appLock(appState.lock, signedIn: appState.phase == .signedIn)
        .offlineMode(appState)
        .onChange(of: appState.phase) { appState.lock.reset() }
        .task(id: isPolling) {
            guard isPolling else { return }
            await appState.refreshSession()
            await appState.runPolling()
        }
        // After sign-in (and on launch with a saved session): ask about notifications and register this iPhone.
        .task(id: appState.phase) {
            await appState.activatePush()
        }
    }
}

#if DEBUG
#Preview("Вход") {
    RootView()
        .appEnvironment(AppState(api: APIClient(serverURL: URL(string: "http://localhost:3000")!), employee: nil, phase: .signedOut))
}
#endif
