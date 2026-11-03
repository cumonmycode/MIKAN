import SwiftUI

/// How a message looks in the client's Telegram: the picture, the text with `{name}` filled in and the inline buttons
/// under the bubble.
struct TelegramMessagePreview: View {
    @Environment(APIClient.self) private var api
    let text: String
    var imagePath: String?
    var buttons: [String] = []
    var name = CampaignText.sampleName

    private static let maxWidth: CGFloat = 340
    private static let imageHeight: CGFloat = 190
    private static let bubbleRadius: CGFloat = 18

    private var personalized: String { CampaignText.personalized(text.trimmed, name: name) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            VStack(alignment: .leading, spacing: 0) {
                if let url = api.mediaURL(for: imagePath) {
                    picture(url)
                }
                Group {
                    if personalized.isEmpty {
                        Text("Здесь появится текст сообщения").foregroundStyle(.secondary)
                    } else {
                        Text(ChatMarkdown.render(personalized))
                    }
                }
                .font(.callout)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: Self.bubbleRadius))
            .clipShape(.rect(cornerRadius: Self.bubbleRadius))
            ForEach(buttons, id: \.self) { title in
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 12))
            }
        }
        .frame(maxWidth: Self.maxWidth, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private func picture(_ url: URL) -> some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image.resizable().scaledToFill()
            case .failure:
                Image(systemName: "photo.badge.exclamationmark").font(.title).foregroundStyle(.secondary)
            default:
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: Self.imageHeight)
        .background(Color(.tertiarySystemFill))
        .clipped()
    }

    private var accessibilityText: String {
        var parts: [String] = imagePath == nil ? [] : ["Картинка"]
        parts.append(ChatMarkdown.plain(personalized))
        parts += buttons.map { "Кнопка «\($0)»" }
        return "Так увидит клиент: " + parts.joined(separator: ". ")
    }
}

#if DEBUG
#Preview {
    TelegramMessagePreview(
        text: "{name}, **новые украшения** уже в студии! Приходите выбрать 💛",
        buttons: [CampaignButton.bookTitle, CampaignPresentation.optOutButtonTitle]
    )
    .padding()
    .previewEnvironment()
}
#endif
