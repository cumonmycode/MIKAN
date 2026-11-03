import SwiftUI

extension View {
    /// Runs the offline mode for the app (docs/API.md «Offline mode (app)»): watches the network, opens the phone's
    /// copy once signed in and unlocked, refreshes everything on getting back online, and keeps the copy fresh.
    func offlineMode(_ appState: AppState) -> some View {
        modifier(OfflineModeDriver(appState: appState))
    }
}

private struct OfflineModeDriver: ViewModifier {
    let appState: AppState
    @Environment(\.scenePhase) private var scenePhase

    /// The saved copy is opened only behind an unlocked app: nothing saved shows before Face ID.
    private var opensCopy: Bool { appState.phase == .signedIn && !appState.lock.isLocked }
    private var ticks: Bool { appState.phase == .signedIn && scenePhase == .active }

    func body(content: Content) -> some View {
        content
            .task { appState.connectivity.start() }
            .task(id: opensCopy) {
                guard opensCopy else { return }
                await appState.openOfflineData()
            }
            .onChange(of: appState.connectivity.reconnects) {
                Task { await appState.refreshAfterReconnect() }
            }
            .task(id: ticks) {
                guard ticks else { return }
                while !Task.isCancelled {
                    try? await Task.sleep(for: AppState.offlineTickInterval)
                    guard !Task.isCancelled else { return }
                    await appState.offlineTick()
                }
            }
    }
}
