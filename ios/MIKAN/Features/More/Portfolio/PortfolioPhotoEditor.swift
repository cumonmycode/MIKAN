import SwiftUI

/// Caption and service of one portfolio photo, and its removal.
struct PortfolioPhotoEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(APIClient.self) private var api
    @Environment(ReferenceStore.self) private var reference

    let photo: PortfolioPhoto
    let onSaved: (PortfolioPhoto) -> Void
    let onDeleted: (Int) -> Void

    @State private var caption: String
    @State private var serviceId: Int?
    @State private var isSaving = false
    @State private var confirmsDelete = false
    @State private var errorMessage: String?
    @State private var servicesError: String?

    private static let previewMaxHeight: CGFloat = 360
    private static let previewMinHeight: CGFloat = 200

    init(photo: PortfolioPhoto, onSaved: @escaping (PortfolioPhoto) -> Void, onDeleted: @escaping (Int) -> Void) {
        self.photo = photo
        self.onSaved = onSaved
        self.onDeleted = onDeleted
        _caption = State(initialValue: photo.caption ?? "")
        _serviceId = State(initialValue: photo.service?.id)
    }

    private var captionMessage: String? { PortfolioLimits.captionMessage(caption) }
    private var hasChanges: Bool { caption.nonEmpty != photo.caption.nonEmpty || serviceId != photo.service?.id }
    private var canSave: Bool { captionMessage == nil && !isSaving }
    private var serviceOptions: [ServiceRef] {
        PortfolioServices.options(active: reference.activeServices.map(\.ref), current: photo.service)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section { preview }
                captionSection
                serviceSection
                Section {
                    Button("Удалить фото", systemImage: "trash", role: .destructive) { confirmsDelete = true }
                        .disabled(isSaving)
                }
            }
            .navigationTitle("Фото работы")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving { ProgressView() } else { Button("Сохранить", action: save).disabled(!canSave) }
                }
            }
            .confirmationDialog("Удалить фото?", isPresented: $confirmsDelete, titleVisibility: .visible) {
                Button("Удалить", role: .destructive, action: delete)
                Button("Отмена", role: .cancel) {}
            } message: {
                Text(PortfolioText.deleteWarning)
            }
            .interactiveDismissDisabled(isSaving)
            .errorAlert($errorMessage)
            .task { await loadServices() }
        }
    }

    // MARK: - Sections

    private var preview: some View {
        AsyncImage(url: api.mediaURL(for: photo.imageUrl), transaction: Transaction(animation: .easeOut(duration: 0.2))) { phase in
            switch phase {
            case .success(let image):
                image.resizable().scaledToFit()
            case .failure:
                ContentUnavailableView("Не удалось загрузить фото", systemImage: "photo.badge.exclamationmark")
            default:
                ProgressView().controlSize(.large)
            }
        }
        .frame(maxWidth: .infinity, minHeight: Self.previewMinHeight, maxHeight: Self.previewMaxHeight)
        .clipShape(.rect(cornerRadius: 12))
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
        .accessibilityLabel(photo.caption.nonEmpty.map { "Фото работы: \($0)" } ?? "Фото работы")
    }

    private var captionSection: some View {
        Section {
            TextField("Например: хеликс, титан, кольцо 8 мм", text: $caption, axis: .vertical)
                .lineLimit(2...6)
        } header: {
            Text("Подпись")
        } footer: {
            if let captionMessage {
                Text(captionMessage).foregroundStyle(.red)
            } else {
                Text("\(PortfolioLimits.captionLength(caption)) из \(PortfolioLimits.maxCaptionLength). Клиенты видят подпись под фото.")
            }
        }
    }

    private var serviceSection: some View {
        Section {
            Picker("Услуга", selection: $serviceId) {
                Text("Без услуги").tag(Int?.none)
                ForEach(ServiceCategory.allCases) { category in
                    let services = serviceOptions.filter { $0.category == category }
                    if !services.isEmpty {
                        Section(category.title) {
                            ForEach(services) { service in
                                Text(service.name).tag(Int?.some(service.id))
                            }
                        }
                    }
                }
            }
            .pickerStyle(.navigationLink)
        } footer: {
            if let servicesError {
                Text("Не удалось загрузить услуги. \(servicesError)").foregroundStyle(.red)
            } else {
                Text("Фото с услугой клиенты видят в «Работах мастеров» этой услуги при онлайн-записи.")
            }
        }
    }

    // MARK: - Actions

    private func loadServices() async {
        do {
            try await reference.ensureServices()
            servicesError = nil
        } catch is CancellationError {
            return
        } catch {
            servicesError = error.userMessage
        }
    }

    private func save() {
        guard hasChanges else {
            dismiss()
            return
        }
        let body = PortfolioPhotoPatch(caption: caption, serviceId: serviceId)
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                onSaved(try await api.updatePortfolioPhoto(id: photo.id, body))
                dismiss()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }

    private func delete() {
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                try await api.deletePortfolioPhoto(id: photo.id)
                onDeleted(photo.id)
                dismiss()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}
