import PhotosUI
import SwiftUI

/// Campaign editor: the name staff see and the message text with `{name}` and the length limit.
struct CampaignMessageSections: View {
    @Binding var draft: CampaignDraft

    var body: some View {
        Section {
            TextField("Например: Осенняя акция на пирсинг", text: $draft.title)
        } header: {
            Text("Название")
        } footer: {
            if !draft.title.trimmed.isEmpty, let issue = draft.titleIssue {
                Text(issue).foregroundStyle(.red)
            } else {
                Text("Видно только сотрудникам.")
            }
        }
        Section {
            NameTokenTextField(
                placeholder: "Текст сообщения",
                text: $draft.text,
                limit: CampaignText.limit(hasImage: draft.hasImage)
            )
        } header: {
            Text("Сообщение")
        } footer: {
            if CampaignText.isTooLong(draft.text, hasImage: draft.hasImage), let issue = draft.textIssue {
                Text(issue).foregroundStyle(.red)
            } else {
                Text(verbatim: "«Имя клиента» вставляет {name} — бот подставит имя каждого. Можно выделить **жирным** и сделать список строками «- ».")
            }
        }
    }
}

/// Campaign editor: an optional picture, sent as a photo with the text as caption.
struct CampaignImageSection: View {
    @Environment(APIClient.self) private var api
    @Binding var imageUrl: String?
    @Binding var isUploading: Bool
    @Binding var errorMessage: String?

    @State private var pickerItem: PhotosPickerItem?

    private static let thumbnailSize: CGFloat = 72

    var body: some View {
        Section {
            HStack(spacing: 16) {
                ZStack {
                    ProductThumbnail(path: imageUrl, size: Self.thumbnailSize, placeholderSymbol: "photo")
                    if isUploading {
                        ProgressView()
                            .frame(width: Self.thumbnailSize, height: Self.thumbnailSize)
                            .background(.ultraThinMaterial, in: .rect(cornerRadius: Self.thumbnailSize * 0.22))
                    }
                }
                VStack(alignment: .leading, spacing: 10) {
                    // The picker label closure is Sendable, so the title is computed outside it.
                    let pickerTitle = imageUrl == nil ? "Добавить картинку" : "Заменить"
                    PhotosPicker(selection: $pickerItem, matching: .images, photoLibrary: .shared()) {
                        Label(pickerTitle, systemImage: "photo.on.rectangle")
                    }
                    .disabled(isUploading)
                    if imageUrl != nil {
                        Button("Убрать", systemImage: "trash", role: .destructive) { imageUrl = nil }
                            .disabled(isUploading)
                    }
                }
                .buttonStyle(.borderless)
            }
            .padding(.vertical, 4)
            .onChange(of: pickerItem) { _, item in
                guard let item else { return }
                Task { await upload(item) }
            }
        } header: {
            Text("Картинка")
        } footer: {
            Text("Необязательно. С картинкой текст становится подписью к фото — Telegram разрешает до \(Money.group(UInt(CampaignText.maxCaptionLength))) символов.")
        }
    }

    private func upload(_ item: PhotosPickerItem) async {
        isUploading = true
        defer {
            isUploading = false
            pickerItem = nil
        }
        do {
            imageUrl = try await ServiceImageUpload.upload(item, api: api)
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.userMessage
        }
    }
}

/// Campaign editor: the inline button under the message — none, «📅 Записаться» or a link.
struct CampaignButtonSection: View {
    @Binding var draft: CampaignDraft

    var body: some View {
        Section {
            Picker("Кнопка", selection: $draft.buttonChoice.animation()) {
                ForEach(CampaignButtonChoice.allCases, id: \.self) { choice in
                    Text(choice.title).tag(choice)
                }
            }
            .pickerStyle(.segmented)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
            if draft.buttonChoice == .link {
                TextField("Текст кнопки", text: $draft.linkTitle)
                TextField("https://", text: $draft.linkURL)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
        } header: {
            Text("Кнопка под сообщением")
        } footer: {
            footer
        }
    }

    @ViewBuilder
    private var footer: some View {
        switch draft.buttonChoice {
        case .none:
            Text("Под сообщением будет только «\(CampaignPresentation.optOutButtonTitle)» — она есть в каждой рассылке.")
        case .book:
            Text("«\(CampaignButton.bookTitle)» откроет онлайн-запись, а если она выключена — бот предложит записаться прямо в чате.")
        case .link:
            if let issue = draft.buttonIssue, draft.linkURL.trimmed != CampaignDraft.linkPrefix {
                Text(issue).foregroundStyle(.red)
            } else {
                Text("Любая ссылка, которая начинается с https:// — сайт, Instagram, страница акции.")
            }
        }
    }
}

/// Campaign editor: the live preview of the message in Telegram.
struct CampaignPreviewSection: View {
    let draft: CampaignDraft
    let audience: CampaignAudience?

    var body: some View {
        Section {
            TelegramMessagePreview(
                text: draft.text,
                imagePath: draft.imageUrl,
                buttons: CampaignPresentation.buttons(draft.button),
                name: CampaignText.previewName(audience?.sample.first)
            )
            .padding(.vertical, 6)
        } header: {
            Text("Как увидит клиент")
        } footer: {
            Text("Вместо {name} — имя клиента, здесь для примера «\(CampaignText.previewName(audience?.sample.first))».")
        }
    }
}
