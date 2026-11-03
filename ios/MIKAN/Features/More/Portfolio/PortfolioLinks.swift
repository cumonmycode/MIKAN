import SwiftUI

/// «Портфолио» in a master's card (one-line hook in `EmployeeEditorView`).
struct PortfolioLinkSection: View {
    let employee: Employee

    var body: some View {
        Section {
            NavigationLink {
                PortfolioView(employee: employee.ref)
            } label: {
                Label("Портфолио", systemImage: "photo.on.rectangle.angled")
            }
        } footer: {
            Text("Фото работ мастера: клиенты видят их при онлайн-записи, бот показывает по просьбе.")
        }
    }
}

/// «Моё портфолио» in «Ещё → Аккаунт» for masters (one-line hook).
struct MyPortfolioLink: View {
    let employee: Employee

    var body: some View {
        if employee.isMaster {
            NavigationLink {
                PortfolioView(employee: employee.ref)
            } label: {
                Label("Моё портфолио", systemImage: "photo.on.rectangle.angled")
            }
        }
    }
}

/// «Портфолио мастеров» in «Ещё → Студия» for owner and admin: an admin can't open other employees' cards,
/// so this is their way to every master's photos.
struct MastersPortfolioLink: View {
    @Environment(\.permissions) private var permissions

    var body: some View {
        if permissions.managesAllPortfolios {
            NavigationLink { MastersPortfolioView() } label: {
                Label("Портфолио мастеров", systemImage: "photo.on.rectangle.angled")
            }
        }
    }
}

/// Active masters, each opening their portfolio.
struct MastersPortfolioView: View {
    @Environment(ReferenceStore.self) private var reference
    @State private var masters = Remote<[Employee]>()

    var body: some View {
        List {
            if let items = masters.value, !items.isEmpty {
                Section {
                    ForEach(items) { master in row(master) }
                } footer: {
                    Text("Фото работ клиенты видят при онлайн-записи, бот показывает их по просьбе.")
                }
            }
        }
        .overlay {
            RemoteStateOverlay(remote: masters, retry: { await load(force: true) }) {
                ContentUnavailableView(
                    "Мастеров нет",
                    systemImage: "person.3",
                    description: Text("Отметьте сотрудника мастером в его карточке.")
                )
            }
        }
        .refreshable { await load(force: true) }
        .task { await load(force: false) }
        .remoteErrorAlert(masters)
        .navigationTitle("Портфолио мастеров")
    }

    private func row(_ master: Employee) -> some View {
        NavigationLink {
            PortfolioView(employee: master.ref)
        } label: {
            HStack(spacing: 12) {
                InitialsAvatar(name: master.name, color: .master(master.color), size: 40)
                Text(master.name).font(.headline)
            }
        }
    }

    private func load(force: Bool) async {
        await masters.load {
            try await reference.ensureEmployees(force: force)
            return reference.masters
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        MastersPortfolioView()
    }
    .previewEnvironment()
}
#endif
