import SwiftUI

/// A multi-line message field with a chip that puts `{name}` (the client's first name) at the cursor, and a counter
/// against `limit` (red once over).
struct NameTokenTextField: View {
    let placeholder: String
    @Binding var text: String
    let limit: Int
    var lineLimit: ClosedRange<Int> = 4...14

    @State private var selection: TextSelection?

    private var length: Int { CampaignText.length(text) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField(placeholder, text: $text, selection: $selection, axis: .vertical)
                .lineLimit(lineLimit)
            HStack {
                Button(action: insertName) {
                    Label("Имя клиента", systemImage: "person.crop.circle.badge.plus")
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .accessibilityHint("Вставляет {name} — бот подставит имя каждого клиента")
                Spacer()
                Text("\(Money.group(UInt(length))) / \(Money.group(UInt(limit)))")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(length > limit ? Color.red : Color.secondary)
                    .accessibilityLabel("Символов: \(length) из \(limit)")
            }
        }
        .padding(.vertical, 4)
    }

    private func insertName() {
        var range: Range<String.Index>?
        if case .selection(let selected)? = selection?.indices { range = selected }
        let result = CampaignText.inserting(CampaignText.nameToken, into: text, replacing: range)
        text = result.text
        let cursor = text.index(text.startIndex, offsetBy: result.cursorOffset, limitedBy: text.endIndex) ?? text.endIndex
        selection = TextSelection(insertionPoint: cursor)
    }
}

#if DEBUG
#Preview {
    @Previewable @State var text = "{name}, у нас новые украшения из титана!"
    Form {
        NameTokenTextField(placeholder: "Текст", text: $text, limit: CampaignText.maxLength)
    }
}
#endif
