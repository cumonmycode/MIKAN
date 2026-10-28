import SwiftUI

/// A tap on an archive photo (Titan `photo-grid.tsx`, `usePhotoActions`): what is in it (the marketer's description)
/// and the actions — add it to the post the archive was opened from, or open the original in Google Drive.
/// `onAdded` runs after the photo went into the post (the screens then go back to the post).
struct SmmArchivePhotoDialog: ViewModifier {
    @Environment(APIClient.self) private var api
    @Environment(SmmProfileStore.self) private var store
    @Environment(\.openURL) private var openURL
    @Binding var photo: SmmLibraryPhoto?
    @Binding var addingId: String?
    let postId: String?
    let onAdded: () -> Void

    @State private var errorMessage: String?
    @State private var addedCount = 0

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                photo.map(Self.title(of:)) ?? "Фото",
                isPresented: Binding(get: { photo != nil }, set: { if !$0 { photo = nil } }),
                titleVisibility: .visible,
                presenting: photo
            ) { photo in
                if postId != nil {
                    Button("Добавить в публикацию") { add(photo) }
                }
                if let url = photo.driveURL {
                    Button("Открыть оригинал") { openURL(url) }
                }
                Button("Закрыть", role: .cancel) {}
            } message: { photo in
                Text(Self.message(of: photo))
            }
            .errorAlert($errorMessage, title: "Фото не добавилось")
            .sensoryFeedback(.success, trigger: addedCount)
    }

    private func add(_ photo: SmmLibraryPhoto) {
        guard let postId else { return }
        let profile = store.profile
        addingId = photo.id
        Task {
            defer { addingId = nil }
            do {
                _ = try await api.addSmmArchivePhoto(profile, postId: postId, photoId: photo.id)
                addedCount += 1
                onAdded()
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
    }

    /// «Шаблон сторис · Альбом» or just the album's name.
    private static func title(of photo: SmmLibraryPhoto) -> String {
        let album = photo.path.components(separatedBy: " / ").last?.nonEmpty ?? "Архив"
        guard let kind = kindTitle(photo.kind) else { return album }
        return "\(kind) · \(album)"
    }

    private static func message(of photo: SmmLibraryPhoto) -> String {
        var lines = [photo.description.nonEmpty ?? photo.name]
        if let tags = photo.tags.nonEmpty {
            lines.append(tags)
        }
        if photo.usedCount > 0 {
            lines.append("Уже было в постах: \(photo.usedCount)")
        }
        return lines.joined(separator: "\n\n")
    }

    private static func kindTitle(_ kind: SmmLibraryKind) -> String? {
        switch kind {
        case .template: "Шаблон сторис"
        case .logo: "Логотип"
        case .design: "Дизайн"
        case .video: "Видео"
        case .photo, .unknown: nil
        }
    }
}

extension View {
    /// The archive photo's dialog; see `SmmArchivePhotoDialog`.
    func smmArchivePhotoDialog(
        photo: Binding<SmmLibraryPhoto?>,
        addingId: Binding<String?>,
        postId: String?,
        onAdded: @escaping () -> Void
    ) -> some View {
        modifier(SmmArchivePhotoDialog(photo: photo, addingId: addingId, postId: postId, onAdded: onAdded))
    }
}
