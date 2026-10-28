import SwiftUI

/// «Права» in the employee editor: the role picker (the owner, for a new or another employee) or, on your own card,
/// the role as text — with what the role may do.
struct EmployeeRoleSection: View {
    @Binding var role: EmployeeRole
    let isEditable: Bool

    var body: some View {
        Section {
            if isEditable {
                Picker("Роль", selection: $role) {
                    ForEach(EmployeeRole.allCases, id: \.self) { role in
                        Text(role.title).tag(role)
                    }
                }
            } else {
                LabeledContent("Роль", value: role.title)
            }
        } header: {
            Text("Права")
        } footer: {
            // Only your own card shows the role as text: nobody changes their own role.
            Text(isEditable ? role.abilities : "\(role.abilities) Свою роль поменять нельзя.")
        }
    }
}

#if DEBUG
#Preview {
    @Previewable @State var role = EmployeeRole.master
    Form {
        EmployeeRoleSection(role: $role, isEditable: true)
        EmployeeRoleSection(role: .constant(.admin), isEditable: false)
    }
}
#endif
