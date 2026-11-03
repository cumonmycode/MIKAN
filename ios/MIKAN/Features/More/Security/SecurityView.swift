import SwiftUI

/// More → «Безопасность» (docs/API.md «Sessions»): the Face ID lock, the devices signed in and signing out everywhere.
/// The owner sees every employee's devices, grouped by employee.
struct SecurityView: View {
    @Environment(AppState.self) private var appState
    @Environment(AppLock.self) private var lock
    @Environment(APIClient.self) private var api
    @State private var sessions = Remote<[AuthSession]>()
    @State private var ending: AuthSession?
    @State private var confirmsSignOutEverywhere = false
    @State private var isSigningOutEverywhere = false
    @State private var errorMessage: String?

    private var me: Employee? { appState.employee }
    private var isOwner: Bool { me?.role == .owner }
    private var groups: [SessionGroup] { SessionGrouping.groups(sessions.value ?? [], me: me?.id) }

    var body: some View {
        List {
            AppLockSection(lock: lock)
            sessionSections
            Section {
                Button(role: .destructive) {
                    confirmsSignOutEverywhere = true
                } label: {
                    if isSigningOutEverywhere {
                        ProgressView()
                    } else {
                        Label("Выйти на всех устройствах", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                }
                .disabled(isSigningOutEverywhere)
            } footer: {
                Text("Ваш аккаунт закроется на всех устройствах, включая этот iPhone.")
            }
        }
        .auraBackground()
        .navigationTitle("Безопасность")
        .refreshable { await load() }
        .task { await load() }
        .remoteErrorAlert(sessions)
        .errorAlert($errorMessage)
        .confirmationDialog(
            "Завершить сессию?",
            isPresented: Binding(get: { ending != nil }, set: { if !$0 { ending = nil } }),
            titleVisibility: .visible,
            presenting: ending
        ) { session in
            Button("Завершить", role: .destructive) {
                Task { await end(session) }
            }
            Button("Отмена", role: .cancel) {}
        } message: { session in
            Text("На устройстве «\(session.deviceTitle)» понадобится войти снова.")
        }
        .confirmationDialog("Выйти на всех устройствах?", isPresented: $confirmsSignOutEverywhere, titleVisibility: .visible) {
            Button("Выйти везде", role: .destructive) {
                Task { await signOutEverywhere() }
            }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Чтобы продолжить работу, понадобится войти снова.")
        }
    }

    @ViewBuilder private var sessionSections: some View {
        if let failure = sessions.failure {
            Section("Устройства") {
                Text(failure).foregroundStyle(.secondary)
                Button("Повторить") { Task { await load() } }
            }
        } else if sessions.value == nil {
            Section("Устройства") {
                ProgressView().frame(maxWidth: .infinity)
            }
        } else if groups.isEmpty {
            Section("Устройства") {
                Text("Нет устройств с выполненным входом").foregroundStyle(.secondary)
            }
        } else if isOwner {
            ForEach(groups) { group in
                Section {
                    ForEach(group.sessions) { session in row(session) }
                } header: {
                    Text(group.employee.id == me?.id ? "\(group.employee.name) (вы)" : group.employee.name)
                }
            }
        } else {
            Section {
                ForEach(groups.flatMap(\.sessions)) { session in row(session) }
            } header: {
                Text("Устройства")
            } footer: {
                Text("Где выполнен вход в ваш аккаунт. Завершите сессию на устройстве, которым больше не пользуетесь.")
            }
        }
    }

    private func row(_ session: AuthSession) -> some View {
        SessionRow(session: session) {
            ending = session
        }
        // No destructive role: the row stays until the confirmation is answered.
        .swipeActions {
            if !session.current {
                Button("Завершить") { ending = session }
                    .tint(.red)
            }
        }
    }

    private func load() async {
        await sessions.load { try await api.sessions() }
    }

    private func end(_ session: AuthSession) async {
        do {
            try await api.endSession(id: session.id)
            sessions.remove(id: session.id)
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.userMessage
        }
    }

    /// The employee's other devices first, then this one.
    private func signOutEverywhere() async {
        guard let me else { return }
        isSigningOutEverywhere = true
        defer { isSigningOutEverywhere = false }
        do {
            let own = try await api.sessions(employeeId: me.id)
            for id in SessionGrouping.otherSessionIds(own, employeeId: me.id) {
                try await api.endSession(id: id)
            }
            appState.signOut()
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.userMessage
        }
    }
}

/// The Face ID lock switch.
private struct AppLockSection: View {
    let lock: AppLock

    private var isAvailable: Bool { lock.method != .unavailable }

    var body: some View {
        Section {
            Toggle(isOn: Binding(get: { isAvailable && lock.isEnabled }, set: { lock.setEnabled($0) })) {
                Label(lock.method.toggleTitle, systemImage: lock.method.systemImage)
            }
            .disabled(!isAvailable)
        } header: {
            Text("Блокировка")
        } footer: {
            Text(isAvailable
                ? "MIKAN попросит \(lock.method.title) или код-пароль после запуска и если приложение было свёрнуто дольше 5 минут."
                : "На iPhone не задан код-пароль, поэтому приложение нельзя заблокировать. Включите его в Настройках → «Face ID и код-пароль».")
        }
    }
}

private extension DeviceAuthentication.Method {
    /// «Вход по Face ID», «Вход по коду-паролю».
    var toggleTitle: String {
        switch self {
        case .faceID, .touchID, .opticID: "Вход по \(title)"
        case .passcode, .unavailable: "Вход по коду-паролю"
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        SecurityView()
    }
    .previewEnvironment()
}
#endif
