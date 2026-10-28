import PhotosUI
import SwiftUI

/// One master's photos of works, in the master's order. Whoever manages this portfolio (the master, owner, admin) adds
/// library photos, sets a caption and service, drags tiles to reorder and deletes; everyone else only looks.
struct PortfolioView: View {
    @Environment(APIClient.self) private var api
    @Environment(\.permissions) private var permissions
    @State private var model: PortfolioModel
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var editing: PortfolioPhoto?
    @State private var viewer: ServicePhotoViewerItem?
    @State private var deleting: PortfolioPhoto?

    private static let spacing: CGFloat = 4
    private static let columnCount = 3

    init(employee: EmployeeRef) {
        _model = State(initialValue: PortfolioModel(employee: employee))
    }

    private var employee: EmployeeRef { model.employee }
    private var isOwn: Bool { employee.id == permissions.employeeId }
    private var canManage: Bool { permissions.managesPortfolio(of: employee.id) }
    private var photos: [PortfolioPhoto] { model.photos.value ?? [] }
    private var columns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: Self.spacing), count: Self.columnCount)
    }

    var body: some View {
        ScrollView {
            if !photos.isEmpty || model.isUploading {
                VStack(alignment: .leading, spacing: 10) {
                    if canManage { header }
                    LazyVGrid(columns: columns, spacing: Self.spacing) {
                        ForEach(Array(photos.enumerated()), id: \.element.id) { index, photo in
                            tile(photo, index: index)
                        }
                        if let upload = model.upload {
                            PortfolioUploadTile(progress: upload)
                        }
                    }
                }
                .padding(.horizontal)
                .padding(.bottom)
            }
        }
        .overlay {
            RemoteStateOverlay(remote: model.photos, isEmpty: { $0.isEmpty && !model.isUploading }, retry: load) {
                emptyState
            }
        }
        .refreshable { await load() }
        .task { if model.photos.value == nil { await load() } }
        .remoteErrorAlert(model.photos)
        .errorAlert($model.errorMessage)
        .navigationTitle(isOwn ? "Моё портфолио" : "Портфолио")
        .modifier(PortfolioSubtitle(name: isOwn ? nil : employee.name))
        .toolbar {
            if canManage {
                ToolbarItem(placement: .topBarTrailing) { addButton }
            }
        }
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            pickerItems = []
            Task { await model.add(items, api: api) }
        }
        .sheet(item: $editing) { photo in
            PortfolioPhotoEditor(photo: photo, onSaved: { model.replace($0) }, onDeleted: { model.remove(id: $0) })
        }
        .fullScreenCover(item: $viewer) { item in
            ServicePhotoViewer(item: item)
        }
        .confirmationDialog("Удалить фото?", isPresented: deleteDialogBinding, titleVisibility: .visible, presenting: deleting) { photo in
            Button("Удалить", role: .destructive) {
                Task { await model.delete(photo, api: api) }
            }
            Button("Отмена", role: .cancel) {}
        } message: { _ in
            Text(PortfolioText.deleteWarning)
        }
    }

    // MARK: - Parts

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(PortfolioLimits.remaining(current: model.count) == 0
                ? "В портфолио уже \(PortfolioLimits.maxPhotos) фото — удалите лишние, чтобы добавить новые."
                : "Перетащите фото, чтобы поменять порядок: клиенты видят первые фото первыми.")
            Spacer(minLength: 0)
            Text("\(model.count) из \(PortfolioLimits.maxPhotos)")
                .monospacedDigit()
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(.top, 8)
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("Пока нет работ", systemImage: "photo.on.rectangle.angled")
        } description: {
            Text(canManage
                ? "Добавьте фото работ кнопкой «+»: клиенты увидят их при онлайн-записи, бот покажет по просьбе."
                : "Мастер ещё не добавил фото работ.")
        }
    }

    private var addButton: some View {
        PhotosPicker(
            selection: $pickerItems,
            maxSelectionCount: max(1, model.pickLimit),
            selectionBehavior: .ordered,
            matching: .images,
            photoLibrary: .shared()
        ) {
            Label("Добавить фото", systemImage: "plus")
        }
        .disabled(model.isUploading || model.pickLimit == 0 || model.photos.value == nil)
    }

    @ViewBuilder
    private func tile(_ photo: PortfolioPhoto, index: Int) -> some View {
        let button = Button {
            open(photo, index: index)
        } label: {
            PortfolioTile(photo: photo, isBusy: model.deleting.contains(photo.id))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(PortfolioText.accessibilityLabel(photo, index: index, count: photos.count))
        .accessibilityHint(canManage ? "Подпись и услуга" : "Открыть на весь экран")

        if canManage {
            button
                .contextMenu { menu(photo, index: index) }
                .draggable(PortfolioReorder.dragPayload(for: photo.id))
                .dropDestination(for: String.self, isEnabled: model.canReorder) { payloads, _ in
                    guard let dragged = payloads.first.flatMap(PortfolioReorder.photoId(fromDragPayload:)) else { return }
                    Task { await model.move(dragged, onto: photo.id, api: api) }
                }
                .accessibilityActions { moveActions(photo, index: index) }
        } else {
            button
        }
    }

    @ViewBuilder
    private func menu(_ photo: PortfolioPhoto, index: Int) -> some View {
        Button("Подпись и услуга", systemImage: "text.below.photo") { editing = photo }
        Button("На весь экран", systemImage: "arrow.up.left.and.arrow.down.right") { showFullScreen(from: index) }
        Button("Удалить", systemImage: "trash", role: .destructive) { deleting = photo }
    }

    @ViewBuilder
    private func moveActions(_ photo: PortfolioPhoto, index: Int) -> some View {
        if index > 0 {
            Button("Переместить раньше") { Task { await model.move(photo.id, by: -1, api: api) } }
        }
        if index < photos.count - 1 {
            Button("Переместить позже") { Task { await model.move(photo.id, by: 1, api: api) } }
        }
    }

    private var deleteDialogBinding: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    /// A manager edits the photo; everyone else looks at it full screen.
    private func open(_ photo: PortfolioPhoto, index: Int) {
        if canManage {
            editing = photo
        } else {
            showFullScreen(from: index)
        }
    }

    private func showFullScreen(from index: Int) {
        viewer = ServicePhotoViewerItem(paths: photos.map(\.imageUrl), index: index)
    }

    private func load() async {
        await model.load(api: api)
    }
}

/// Another master's name under the title; nothing on one's own portfolio.
private struct PortfolioSubtitle: ViewModifier {
    let name: String?

    func body(content: Content) -> some View {
        if let name {
            content.navigationSubtitle(name)
        } else {
            content
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        PortfolioView(employee: PreviewData.anna.ref)
    }
    .previewEnvironment()
}
#endif
