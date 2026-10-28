import SwiftUI

/// «Журнал действий» in «Ещё → Студия», for the owner only.
struct AuditLogMoreLink: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        if appState.employee?.role == .owner {
            NavigationLink { AuditLogView() } label: {
                Label("Журнал действий", systemImage: "list.bullet.rectangle")
            }
        }
    }
}

/// «История изменений» as the last section of a card built as a `List`, for the owner only.
struct AuditHistorySection: View {
    @Environment(AppState.self) private var appState
    let scope: AuditScope

    var body: some View {
        if appState.employee?.role == .owner {
            Section {
                NavigationLink { AuditLogView(scope: scope) } label: {
                    Label("История изменений", systemImage: "clock.arrow.circlepath")
                }
            }
        }
    }
}

/// The same link as a card, for screens built from cards (the product), for the owner only.
struct AuditHistoryCard: View {
    @Environment(AppState.self) private var appState
    let scope: AuditScope

    var body: some View {
        if appState.employee?.role == .owner {
            NavigationLink { AuditLogView(scope: scope) } label: {
                HStack {
                    Label("История изменений", systemImage: "clock.arrow.circlepath")
                        .font(.headline)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .cardStyle()
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
        }
    }
}
