import SwiftUI

private nonisolated struct PermissionsKey: EnvironmentKey {
    static let defaultValue = Permissions(employee: nil)
}

extension EnvironmentValues {
    /// What the signed-in employee may do; set for the whole app by `appEnvironment(_:)`.
    var permissions: Permissions {
        get { self[PermissionsKey.self] }
        set { self[PermissionsKey.self] = newValue }
    }
}

/// Keeps `\.permissions` in step with the signed-in employee: a role changed by the owner applies once the app
/// refreshes the session (on every return to the foreground).
struct PermissionsEnvironment: ViewModifier {
    let state: AppState

    func body(content: Content) -> some View {
        content.environment(\.permissions, state.permissions)
    }
}

extension AppState {
    var permissions: Permissions { Permissions(employee: employee) }
}
