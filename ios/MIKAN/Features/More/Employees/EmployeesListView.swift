import SwiftUI

struct EmployeesListView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppState.self) private var appState
    @Environment(ReferenceStore.self) private var reference
    @Environment(\.permissions) private var permissions
    @State private var employees = Remote<[Employee]>()
    @State private var editing: EmployeeEditTarget?

    private var active: [Employee] { (employees.value ?? []).filter(\.active) }
    private var inactive: [Employee] { (employees.value ?? []).filter { !$0.active } }

    var body: some View {
        List {
            if !active.isEmpty {
                Section {
                    ForEach(active) { employee in row(employee) }
                } footer: {
                    Text(permissions.managesEmployees
                        ? "Роль решает, что сотрудник может в приложении. Нажмите на сотрудника, чтобы изменить."
                        : "Сотрудников добавляет и меняет владелец студии. Своё имя, телефон, цвет и пароль можно изменить — нажмите на себя.")
                }
            }
            if !inactive.isEmpty {
                Section("Отключены") {
                    ForEach(inactive) { employee in row(employee) }
                }
            }
        }
        .overlay {
            RemoteStateOverlay(remote: employees, retry: load) {
                ContentUnavailableView("Сотрудников нет", systemImage: "person.3")
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .remoteErrorAlert(employees)
        .navigationTitle("Сотрудники")
        .toolbar {
            if permissions.managesEmployees {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Новый сотрудник", systemImage: "plus") { editing = .new }
                }
            }
        }
        .sheet(item: $editing) { target in
            EmployeeEditorView(employee: target.employee, currentEmployeeId: appState.employee?.id) { saved in
                employees.upsert(saved)
                reference.replaceEmployees(employees.value ?? [])
                if saved.id == appState.employee?.id {
                    Task { await appState.refreshSession() }
                }
            }
        }
    }

    private func row(_ employee: Employee) -> some View {
        Button {
            editing = .existing(employee)
        } label: {
            HStack(spacing: 12) {
                InitialsAvatar(name: employee.name, color: .master(employee.color), size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(employee.name).font(.headline).foregroundStyle(.primary)
                        if employee.id == appState.employee?.id {
                            Text("вы").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Text("@\(employee.login) · \(employee.role.title)").font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                if employee.isMaster {
                    StatusBadge(text: "Мастер", color: .master(employee.color))
                }
            }
            .contentShape(.rect)
            .opacity(employee.active ? 1 : 0.55)
        }
        // Others see the team read-only and open only their own card.
        .disabled(!permissions.editAccess(to: employee).canEdit)
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        await employees.load { try await api.employees(includeInactive: true) }
        if let value = employees.value { reference.replaceEmployees(value) }
    }
}

enum EmployeeEditTarget: Identifiable {
    case new
    case existing(Employee)

    var id: String {
        switch self {
        case .new: "new"
        case .existing(let employee): "employee-\(employee.id)"
        }
    }

    var employee: Employee? {
        if case .existing(let employee) = self { return employee }
        return nil
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        EmployeesListView()
    }
    .previewEnvironment()
}
#endif
