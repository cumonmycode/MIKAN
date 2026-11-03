import SwiftUI

extension View {
    /// Hides the signed-in app behind a blur per `AppLock` and asks for Face ID when it is locked.
    func appLock(_ lock: AppLock, signedIn: Bool) -> some View {
        modifier(AppLockCover(lock: lock, signedIn: signedIn))
    }
}

private struct AppLockCover: ViewModifier {
    let lock: AppLock
    let signedIn: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.isSceneCaptured) private var isSceneCaptured

    private var isCovered: Bool { signedIn && lock.isCovered }
    private var asksNow: Bool { signedIn && lock.isLocked && scenePhase == .active }
    /// The system's call interface keeps the scene inactive with the app on screen, and the blur would stay for the whole
    /// call; a screen share would show it to the other side. So the blur then comes only with the background.
    private var staysOnScreen: Bool { lock.callWatch.isOnCall || isSceneCaptured }

    func body(content: Content) -> some View {
        content
            .blur(radius: isCovered ? 30 : 0)
            .allowsHitTesting(!isCovered)
            .accessibilityHidden(isCovered)
            .overlay {
                if isCovered {
                    LockScreen(lock: lock)
                        .transition(.opacity)
                }
            }
            // Covering is instant, so off a call the app switcher's snapshot never catches the content; revealing fades.
            .animation(isCovered ? nil : .smooth(duration: 0.25), value: isCovered)
            .onChange(of: scenePhase) { _, phase in
                lock.callWatch.refresh()
                lock.scenePhaseChanged(to: phase, signedIn: signedIn, staysOnScreen: staysOnScreen)
            }
            .onChange(of: staysOnScreen) { _, stays in
                lock.scenePhaseChanged(to: scenePhase, signedIn: signedIn, staysOnScreen: stays)
            }
            .task(id: asksNow) {
                guard asksNow else { return }
                await lock.unlockAutomatically()
            }
    }
}

/// What a covered app shows: the brand, and while locked the unlock button.
private struct LockScreen: View {
    let lock: AppLock

    var body: some View {
        ZStack {
            Rectangle()
                .fill(.regularMaterial)
                .ignoresSafeArea()
            VStack(spacing: 16) {
                Image(systemName: lock.isLocked ? "lock.fill" : "lock")
                    .font(.system(size: 44, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text("MIKAN")
                    .font(.largeTitle.weight(.bold))
                if lock.isLocked {
                    Text("Приложение заблокировано")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Button {
                        Task { await lock.unlock() }
                    } label: {
                        Label("Разблокировать", systemImage: lock.method.systemImage)
                            .padding(.horizontal, 8)
                    }
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
                    .disabled(lock.isAuthenticating)
                    .padding(.top, 8)
                }
            }
            .padding(32)
        }
    }
}
