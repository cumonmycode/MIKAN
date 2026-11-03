import SwiftUI

/// Client card, «О клиенте»: a small hint while the birthday is empty — most cards have none, so birthday greetings
/// and gifts rarely go out (docs/API.md «Collecting birthdays»). Opens the editor.
struct ClientBirthdayHint: View {
    static let title = "Дата рождения не указана"
    static let message = "Спросите у клиента — в этот день бот поздравит и пришлёт подарок. Год можно не указывать."

    let onAdd: () -> Void

    var body: some View {
        Button(action: onAdd) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(Self.title)
                        .foregroundStyle(.primary)
                    Text(Self.message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: "gift")
                    .foregroundStyle(.tint)
            }
        }
        .accessibilityHint("Открывает редактирование карточки")
    }
}
