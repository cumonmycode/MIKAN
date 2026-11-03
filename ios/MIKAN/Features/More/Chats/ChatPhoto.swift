import SwiftUI

/// A client's photo in the chat; a tap opens it. It needs the employee's token, so it is loaded through `APIClient`:
/// `AsyncImage` can't send the header.
struct ChatPhoto: View {
    @Environment(APIClient.self) private var api
    let file: String
    let onOpen: (UIImage) -> Void
    @State private var image: UIImage?
    @State private var hasFailed = false

    /// So the rows of a long chat don't download again each time they scroll back into view.
    private static let cache = NSCache<NSString, UIImage>()

    init(file: String, onOpen: @escaping (UIImage) -> Void) {
        self.file = file
        self.onOpen = onOpen
        _image = State(initialValue: Self.cache.object(forKey: file as NSString))
    }

    var body: some View {
        Button(action: tapped) { content }
            .buttonStyle(.plain)
            .disabled(image == nil && !hasFailed)
            .accessibilityLabel(accessibilityText)
            .task(id: file) {
                if image == nil { await load() }
            }
    }

    @ViewBuilder
    private var content: some View {
        if let image {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .clipShape(.rect(cornerRadius: 18))
                .frame(maxWidth: 240, maxHeight: 320, alignment: .leading)
        } else {
            ZStack {
                Color(.tertiarySystemFill)
                if hasFailed {
                    Image(systemName: "photo.badge.exclamationmark")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                } else {
                    ProgressView()
                }
            }
            .frame(width: 200, height: 200)
            .clipShape(.rect(cornerRadius: 18))
        }
    }

    private var accessibilityText: String {
        if image != nil { return "Открыть фото клиента" }
        return hasFailed ? "Фото не загрузилось, повторить" : "Фото загружается"
    }

    private func tapped() {
        if let image {
            onOpen(image)
        } else {
            Task { await load() }
        }
    }

    private func load() async {
        hasFailed = false
        do {
            guard let loaded = UIImage(data: try await api.chatPhoto(file: file)) else {
                hasFailed = true
                return
            }
            Self.cache.setObject(loaded, forKey: file as NSString)
            image = loaded
        } catch is CancellationError {
            return
        } catch {
            hasFailed = true
        }
    }
}

/// What the full-screen viewer shows.
struct ChatPhotoItem: Identifiable {
    let id = UUID()
    let image: UIImage
}

/// The photo on a black screen: pinch to zoom, drag to look around, double tap to zoom in and back.
struct ChatPhotoViewer: View {
    @Environment(\.dismiss) private var dismiss
    let image: UIImage
    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var screen: CGSize = .zero
    @GestureState private var pinch: CGFloat = 1
    @GestureState private var drag: CGSize = .zero

    private static let maxScale: CGFloat = 5
    private static let doubleTapScale: CGFloat = 2.5

    private var isZoomed: Bool { scale > 1 }

    var body: some View {
        NavigationStack {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .scaleEffect(min(max(1, scale * pinch), Self.maxScale))
                .offset(kept(on: scale, CGSize(width: offset.width + drag.width, height: offset.height + drag.height)))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(.rect)
                .onGeometryChange(for: CGSize.self, of: \.size) { screen = $0 }
                .onTapGesture(count: 2, perform: toggleZoom)
                .gesture(pan, isEnabled: isZoomed)
                .simultaneousGesture(zoom)
                .background(Color.black.ignoresSafeArea())
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Закрыть", systemImage: "xmark") { dismiss() }
                    }
                }
                .accessibilityLabel("Фото клиента")
        }
        .environment(\.colorScheme, .dark)
    }

    private var zoom: some Gesture {
        MagnifyGesture()
            .updating($pinch) { value, state, _ in state = value.magnification }
            .onEnded { value in
                scale = min(max(1, scale * value.magnification), Self.maxScale)
                offset = kept(on: scale, offset)
            }
    }

    private var pan: some Gesture {
        DragGesture()
            .updating($drag) { value, state, _ in state = value.translation }
            .onEnded { value in
                offset = kept(on: scale, CGSize(width: offset.width + value.translation.width, height: offset.height + value.translation.height))
            }
    }

    /// The offset limited so that the zoomed picture can't be dragged off the screen.
    private func kept(on scale: CGFloat, _ offset: CGSize) -> CGSize {
        let limit = CGSize(width: screen.width * (scale - 1) / 2, height: screen.height * (scale - 1) / 2)
        return CGSize(
            width: min(max(offset.width, -limit.width), limit.width),
            height: min(max(offset.height, -limit.height), limit.height)
        )
    }

    private func toggleZoom() {
        withAnimation(.smooth) {
            scale = isZoomed ? 1 : Self.doubleTapScale
            offset = .zero
        }
    }
}
