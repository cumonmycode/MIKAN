import SwiftUI

/// Message bubble: client on the left; AI / staff / automatic on the right with distinct tints and labels.
struct ChatBubble: View {
    let message: BotMessage
    var onOpenPhoto: (UIImage) -> Void = { _ in }

    private var isIncoming: Bool { message.role == .user }

    var body: some View {
        HStack(alignment: .bottom) {
            if !isIncoming { Spacer(minLength: 48) }
            VStack(alignment: isIncoming ? .leading : .trailing, spacing: 3) {
                if let label {
                    Label(label.title, systemImage: label.symbol)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                }
                if let photoFile = message.photoFile {
                    ChatPhoto(file: photoFile, onOpen: onOpenPhoto)
                }
                if !message.displayText.characters.isEmpty {
                    Text(message.displayText)
                        .textSelection(.enabled)
                        .foregroundStyle(foreground)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(background, in: .rect(cornerRadius: 18))
                }
                Text(DateText.time(message.createdAt))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 6)
            }
            if isIncoming { Spacer(minLength: 48) }
        }
        // The photo keeps its own element: it is a button with its own state.
        .accessibilityElement(children: message.photoFile == nil ? .combine : .contain)
        .accessibilityLabel(accessibilityText)
    }

    private var label: (title: String, symbol: String)? {
        switch message.role {
        case .user: nil
        case .assistant: ("ИИ", "sparkles")
        case .staff: (message.employee?.name ?? "Сотрудник", "person.fill")
        case .system: ("Авто", "clock")
        }
    }

    private var background: Color {
        switch message.role {
        case .user: Color(.secondarySystemBackground)
        case .assistant: Color.accentColor.opacity(0.16)
        case .staff: Color.accentColor
        case .system: Color.teal.opacity(0.16)
        }
    }

    private var foreground: Color {
        message.role == .staff ? .white : .primary
    }

    private var accessibilityText: String {
        let author = switch message.role {
        case .user: "Клиент"
        case .assistant: "ИИ"
        case .staff: message.employee?.name ?? "Сотрудник"
        case .system: "Автоматическое сообщение"
        }
        return "\(author), \(DateText.time(message.createdAt)): \(message.plainText)"
    }
}

/// Glass composer floating above the conversation.
struct ChatComposer: View {
    @Binding var text: String
    var placeholder = "Сообщение"
    let isSending: Bool
    let onSend: () -> Void

    private var canSend: Bool { !text.trimmed.isEmpty && !isSending }

    var body: some View {
        GlassEffectContainer(spacing: 10) {
            HStack(alignment: .bottom, spacing: 10) {
                TextField(placeholder, text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
                Button(action: onSend) {
                    Group {
                        if isSending {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "arrow.up").font(.headline.weight(.bold))
                        }
                    }
                    .foregroundStyle(.white)
                    .frame(width: 46, height: 46)
                    .contentShape(.circle)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.tint(canSend ? .accentColor : .gray).interactive(), in: .circle)
                .disabled(!canSend)
                .accessibilityLabel("Отправить")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

#if DEBUG
#Preview {
    ScrollView {
        VStack(spacing: 8) {
            ForEach(PreviewData.messages) { ChatBubble(message: $0) }
        }
        .padding()
    }
    .safeAreaBar(edge: .bottom) {
        ChatComposer(text: .constant(""), isSending: false) {}
    }
}
#endif
