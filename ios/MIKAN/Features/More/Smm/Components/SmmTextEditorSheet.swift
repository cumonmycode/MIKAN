import SwiftUI

/// Full-screen text editor of SMM (Titan `edit-text.tsx`): a post's text edited by hand (the marketer does not rewrite
/// it), the profile's voice, audience and goals, the brand portrait in the staff's words, a shooting zone. Present it in
/// a sheet; it saves through `onSave` with the trimmed text and closes on success, shows the error otherwise.
struct SmmTextEditorSheet: View {
    @Environment(\.dismiss) private var dismiss

    let title: String
    let placeholder: String
    let hint: String?
    let maxLength: Int
    /// An empty text may be saved (settings, knowledge); a post's text may not.
    let allowsEmpty: Bool
    let onSave: (String) async throws -> Void

    private let initial: String
    @State private var text: String
    @State private var isSaving = false
    @State private var errorMessage: String?
    @FocusState private var isFocused: Bool

    static let defaultMaxLength = 4000

    init(
        title: String,
        text: String,
        placeholder: String = "",
        hint: String? = nil,
        maxLength: Int = SmmTextEditorSheet.defaultMaxLength,
        allowsEmpty: Bool = true,
        onSave: @escaping (String) async throws -> Void
    ) {
        self.title = title
        self.placeholder = placeholder
        self.hint = hint
        self.maxLength = maxLength
        self.allowsEmpty = allowsEmpty
        self.onSave = onSave
        initial = text
        _text = State(initialValue: text)
    }

    private var isDirty: Bool { text.trimmed != initial.trimmed }

    private var canSave: Bool { isDirty && !isSaving && (allowsEmpty || !text.trimmed.isEmpty) }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                if let hint = hint.nonEmpty {
                    Text(hint)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                editor
                Text("\(text.count) / \(maxLength)")
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(text.count >= maxLength ? Color.orange : .secondary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .padding(16)
            .background(Color(.systemGroupedBackground))
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Сохранить", action: save)
                            .disabled(!canSave)
                    }
                }
            }
            .interactiveDismissDisabled(isSaving || isDirty)
            .errorAlert($errorMessage, title: "Не сохранилось")
            .onAppear { isFocused = true }
        }
    }

    private var editor: some View {
        TextEditor(text: $text)
            .font(.body)
            .focused($isFocused)
            .scrollContentBackground(.hidden)
            .disabled(isSaving)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .topLeading) {
                if text.isEmpty, !placeholder.isEmpty {
                    Text(placeholder)
                        .font(.body)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 13)
                        .padding(.vertical, 14)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 14))
            .accessibilityLabel(title)
            .onChange(of: text) { _, newValue in
                if newValue.count > maxLength {
                    text = String(newValue.prefix(maxLength))
                }
            }
    }

    private func save() {
        let value = text.trimmed
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                try await onSave(value)
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    SmmTextEditorSheet(
        title: "Текст публикации",
        text: "Новые украшения из титана уже в студии.",
        hint: "Простой текст, хэштеги — в конце, не больше пяти."
    ) { _ in }
}
#endif
