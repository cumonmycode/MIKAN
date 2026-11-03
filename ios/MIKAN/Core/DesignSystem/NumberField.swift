import SwiftUI

/// Numeric text field that updates its binding live on every keystroke (numberPad has no return key,
/// so `TextField(value:format:)` would only commit on focus loss). «Готово» above the keyboard hides it.
struct NumberField: View {
    let title: String
    @Binding var value: Int?
    var systemImage: String?
    var suffix: String?
    var groupsDigits = true
    var placeholder = "0"

    @State private var text = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            if let systemImage {
                Label(title, systemImage: systemImage)
            } else {
                Text(title)
            }
            Spacer(minLength: 12)
            TextField(placeholder, text: $text)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .monospacedDigit()
                .focused($isFocused)
                .frame(maxWidth: 170)
                .accessibilityLabel(title)
            if let suffix {
                Text(suffix).foregroundStyle(.secondary)
            }
        }
        .toolbar {
            // Only the focused field adds the button, so a form of several fields shows one «Готово».
            if isFocused {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Готово") { isFocused = false }
                        .fontWeight(.semibold)
                }
            }
        }
        .onAppear { text = display(value) }
        .onChange(of: text) { _, newText in
            let parsed = Money.parse(newText)
            if parsed != value { value = parsed }
            let formatted = display(parsed)
            if formatted != newText { text = formatted }
        }
        .onChange(of: value) { _, newValue in
            // Only external changes rewrite the text; an emptied required field stays empty while typing.
            if (Money.parse(text) ?? 0) != (newValue ?? 0) { text = display(newValue) }
        }
    }

    private func display(_ number: Int?) -> String {
        guard let number else { return "" }
        return groupsDigits ? Money.group(UInt(max(0, number))) : String(number)
    }
}

extension NumberField {
    /// Required money amount (empty input counts as 0).
    static func money(_ title: String, value: Binding<Int>, systemImage: String? = nil) -> NumberField {
        NumberField(
            title: title,
            value: Binding(get: { value.wrappedValue }, set: { value.wrappedValue = $0 ?? 0 }),
            systemImage: systemImage,
            suffix: Money.symbol
        )
    }

    /// Optional money amount (empty input is `nil`).
    static func optionalMoney(_ title: String, value: Binding<Int?>, placeholder: String = "—") -> NumberField {
        NumberField(title: title, value: value, suffix: Money.symbol, placeholder: placeholder)
    }

    /// Plain integer with an optional unit suffix.
    static func integer(_ title: String, value: Binding<Int>, unit: String? = nil) -> NumberField {
        NumberField(
            title: title,
            value: Binding(get: { value.wrappedValue }, set: { value.wrappedValue = $0 ?? 0 }),
            suffix: unit,
            groupsDigits: false
        )
    }

    static func optionalInteger(_ title: String, value: Binding<Int?>, unit: String? = nil) -> NumberField {
        NumberField(title: title, value: value, suffix: unit, groupsDigits: false, placeholder: "")
    }
}
