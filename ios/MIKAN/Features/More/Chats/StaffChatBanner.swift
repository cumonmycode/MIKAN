import SwiftUI

/// Pinned above a staff chat: whose chat it is and the «Отвязать сотрудника» action
/// (`DELETE /bot/chats/:chatId/employee`, after a confirmation).
struct StaffChatBanner: View {
    @Environment(APIClient.self) private var api
    @Environment(\.permissions) private var permissions

    let chatId: Int64
    let employee: EmployeeRef
    /// Called after the server unlinked the employee.
    let onUnlinked: () -> Void

    @State private var confirmsUnlink = false
    @State private var isUnlinking = false
    @State private var errorMessage: String?

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "person.badge.shield.checkmark")
                .font(.title3)
                .foregroundStyle(Color.master(employee.color))
                .accessibilityHidden(true)
            Text("Чат сотрудника \(employee.name) — бот отвечает как помощник студии")
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            // Staff chat binding is for the owner and admin.
            if permissions.editsSettings {
                Button(role: .destructive) {
                    confirmsUnlink = true
                } label: {
                    if isUnlinking {
                        ProgressView()
                    } else {
                        Text("Отвязать")
                    }
                }
                .buttonStyle(.glass)
                .controlSize(.small)
                .disabled(isUnlinking)
                .accessibilityLabel("Отвязать сотрудника")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .glassEffect(.regular, in: .rect(cornerRadius: 20))
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .confirmationDialog("Отвязать сотрудника?", isPresented: $confirmsUnlink, titleVisibility: .visible) {
            Button("Отвязать сотрудника", role: .destructive, action: unlink)
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("\(employee.name) больше не будет получать от бота записи, клиентов, аналитику и остатки — чат станет обычным клиентским. Чтобы привязать снова, сотрудник может ещё раз поделиться номером в боте, или выберите «Это сотрудник…» в этом чате.")
        }
        .errorAlert($errorMessage)
    }

    private func unlink() {
        isUnlinking = true
        Task {
            defer { isUnlinking = false }
            do {
                try await api.unlinkChatEmployee(chatId: chatId)
                withAnimation(.smooth) { onUnlinked() }
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    VStack {
        StaffChatBanner(chatId: PreviewData.staffChat.chatId, employee: PreviewData.anna.ref) {}
        Spacer()
    }
    .previewEnvironment()
}
#endif
