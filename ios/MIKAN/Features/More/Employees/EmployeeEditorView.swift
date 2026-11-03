import SwiftUI

struct EmployeeEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    @Environment(AppState.self) private var appState
    @Environment(\.permissions) private var permissions

    let employee: Employee?
    let currentEmployeeId: Int?
    let onSaved: (Employee) -> Void

    @State private var name: String
    @State private var login: String
    @State private var password = ""
    @State private var changesPassword = false
    @State private var phone: String
    @State private var color: String
    @State private var isMaster: Bool
    @State private var role: EmployeeRole
    @State private var active: Bool
    @State private var isSaving = false
    @State private var errorMessage: String?

    static let minPasswordLength = 6

    init(employee: Employee?, currentEmployeeId: Int?, onSaved: @escaping (Employee) -> Void) {
        self.employee = employee
        self.currentEmployeeId = currentEmployeeId
        self.onSaved = onSaved
        _name = State(initialValue: employee?.name ?? "")
        _login = State(initialValue: employee?.login ?? "")
        _phone = State(initialValue: employee?.phone ?? "")
        _color = State(initialValue: employee?.color ?? Theme.masterPalette[0])
        _isMaster = State(initialValue: employee?.isMaster ?? true)
        _role = State(initialValue: employee?.role ?? .defaultFor(isMaster: true))
        _active = State(initialValue: employee?.active ?? true)
    }

    private var isCreating: Bool { employee == nil }
    private var isSelf: Bool { employee != nil && employee?.id == currentEmployeeId }
    private var needsPassword: Bool { isCreating || changesPassword }
    private var access: EmployeeEditAccess { permissions.editAccess(to: employee) }

    private var passwordValid: Bool {
        !needsPassword || password.count >= Self.minPasswordLength
    }

    private var canSave: Bool {
        !name.trimmed.isEmpty && !login.trimmed.isEmpty && passwordValid && !isSaving
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Сотрудник") {
                    TextField("Имя", text: $name)
                        .textContentType(.name)
                    TextField("Телефон", text: $phone)
                        .keyboardType(.phonePad)
                        .textContentType(.telephoneNumber)
                }
                Section {
                    TextField("Логин", text: $login)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.username)
                        .disabled(!access.account)
                    if !isCreating {
                        Toggle("Сменить пароль", isOn: $changesPassword.animation())
                    }
                    if needsPassword {
                        SecureField(isCreating ? "Пароль" : "Новый пароль", text: $password)
                            .textContentType(.newPassword)
                    }
                } header: {
                    Text("Вход")
                } footer: {
                    if needsPassword {
                        Text(isSelf
                            ? "Не короче \(Self.minPasswordLength) символов. Другие устройства с вашим аккаунтом потребуют повторного входа."
                            : "Не короче \(Self.minPasswordLength) символов. Сотруднику придётся войти заново.")
                            .foregroundStyle(passwordValid || password.isEmpty ? Color.secondary : Color.red)
                    }
                }
                Section {
                    Toggle("Мастер", isOn: $isMaster)
                        .disabled(!access.account)
                    ColorSwatchPicker(hex: $color)
                } header: {
                    Text("Работа")
                } footer: {
                    Text("Мастера выбираются при записи. Цвет отмечает их записи в календаре.")
                }
                EmployeeRoleSection(role: $role, isEditable: access.role)
                if let employee { WorkScheduleLinkSection(employee: employee) }
                if let employee, employee.isMaster { PortfolioLinkSection(employee: employee) }
                if let employee { PayRulesSection(employee: employee) }
                if !isCreating, permissions.managesEmployees {
                    Section {
                        Toggle("Доступ к приложению", isOn: $active)
                            .disabled(isSelf)
                    } footer: {
                        Text(isSelf ? "Нельзя отключить самого себя." : "Отключённый сотрудник не сможет войти, история сохранится.")
                    }
                }
            }
            .navigationTitle(isCreating ? "Новый сотрудник" : "Сотрудник")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving { ProgressView() } else { Button("Сохранить", action: save).disabled(!canSave) }
                }
            }
            .interactiveDismissDisabled(isSaving)
            .errorAlert($errorMessage)
            // A new employee's role follows «Мастер» until the owner picks another one below it.
            .onChange(of: isMaster) { if isCreating { role = .defaultFor(isMaster: isMaster) } }
        }
    }

    private func save() {
        let body = EmployeeBody.make(
            name: name.trimmed,
            login: login.trimmed,
            password: needsPassword ? password : nil,
            phone: phone.nonEmpty,
            color: color,
            isMaster: isMaster,
            role: role,
            active: active,
            isCreating: isCreating,
            access: access
        )
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let saved = if let employee {
                    try await api.updateEmployee(id: employee.id, body)
                } else {
                    try await api.createEmployee(body)
                }
                if isSelf, needsPassword {
                    // Our own token was just revoked by the password change.
                    await appState.reauthenticate(login: saved.login, password: password)
                }
                onSaved(saved)
                dismiss()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

/// Preset master colors plus a custom color picker.
private struct ColorSwatchPicker: View {
    @Binding var hex: String

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: 5)

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Цвет")
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(Theme.masterPalette, id: \.self) { option in
                    Button {
                        hex = option
                    } label: {
                        Circle()
                            .fill(Color(hex: option) ?? .gray)
                            .frame(width: 34, height: 34)
                            .overlay {
                                if option.caseInsensitiveCompare(hex) == .orderedSame {
                                    Image(systemName: "checkmark")
                                        .font(.caption.weight(.bold))
                                        .foregroundStyle(.white)
                                }
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Цвет \(option)")
                    .accessibilityAddTraits(option.caseInsensitiveCompare(hex) == .orderedSame ? .isSelected : [])
                }
            }
            ColorPicker("Свой цвет", selection: colorBinding, supportsOpacity: false)
        }
        .padding(.vertical, 4)
    }

    private var colorBinding: Binding<Color> {
        Binding(get: { Color(hex: hex) ?? .accentColor }, set: { hex = $0.hexString })
    }
}

#if DEBUG
#Preview {
    EmployeeEditorView(employee: PreviewData.anna, currentEmployeeId: 1) { _ in }
        .previewEnvironment()
}
#endif
