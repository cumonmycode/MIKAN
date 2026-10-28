import Observation
import PhotosUI
import SwiftUI

/// A batch upload in progress: `done` of `total` photos are through.
nonisolated struct PortfolioUploadProgress: Equatable, Sendable {
    let done: Int
    let total: Int

    /// The photo being uploaded now, from 1.
    var current: Int { min(done + 1, total) }
}

/// One master's portfolio: loading, adding a batch of library photos, reordering and deleting.
@Observable
final class PortfolioModel {
    let employee: EmployeeRef
    let photos = Remote<[PortfolioPhoto]>()
    private(set) var upload: PortfolioUploadProgress?
    private(set) var isReordering = false
    /// Photos being deleted (their tiles show a spinner).
    private(set) var deleting: Set<Int> = []
    /// A failed write (upload, reorder, delete), shown as an alert.
    var errorMessage: String?

    init(employee: EmployeeRef) {
        self.employee = employee
    }

    var count: Int { photos.value?.count ?? 0 }
    var isUploading: Bool { upload != nil }
    /// How many photos the library picker may select now.
    var pickLimit: Int { PortfolioLimits.pickLimit(current: count) }
    /// Tiles accept drops only while nothing else changes the list (the server wants every photo in the new order).
    var canReorder: Bool { !isReordering && !isUploading && deleting.isEmpty && photos.value != nil }

    func load(api: APIClient) async {
        let employeeId = employee.id
        await photos.load { try await api.portfolio(employeeId: employeeId) }
    }

    // MARK: - Adding

    /// Adds the picked photos one by one in the picked order, each appearing as it lands;
    /// keeps the ones that made it when some fail.
    func add(_ items: [PhotosPickerItem], api: APIClient) async {
        let batch = Array(items.prefix(pickLimit))
        guard !batch.isEmpty, !isUploading, photos.value != nil else { return }
        upload = PortfolioUploadProgress(done: 0, total: batch.count)
        defer { upload = nil }
        var failures = 0
        var lastError: String?
        for (index, item) in batch.enumerated() {
            guard PortfolioLimits.remaining(current: count) > 0 else { break }
            do {
                let photo = try await addPhoto(item, api: api)
                photos.update { $0 + [photo] }
            } catch is CancellationError {
                return
            } catch {
                failures += 1
                lastError = error.userMessage
            }
            upload = PortfolioUploadProgress(done: index + 1, total: batch.count)
        }
        if failures > 0 {
            errorMessage = PortfolioText.uploadFailure(failures: failures, total: batch.count, lastError: lastError)
        }
    }

    /// Library item → JPEG for full-screen viewing → `POST /uploads` → `POST /portfolio`.
    private func addPhoto(_ item: PhotosPickerItem, api: APIClient) async throws -> PortfolioPhoto {
        guard let data = try await item.loadTransferable(type: Data.self) else {
            throw ImagePreparerError.unreadable
        }
        let jpeg = try await PortfolioImagePreparer.prepare(data)
        let path = try await api.uploadImage(jpegData: jpeg).url
        return try await api.addPortfolioPhoto(PortfolioPhotoBody(employeeId: employee.id, imageUrl: path))
    }

    // MARK: - Order

    /// Drops `id` onto the tile of `target`.
    func move(_ id: Int, onto target: Int, api: APIClient) async {
        await reorder(api: api) { PortfolioReorder.moving(id, onto: target, in: $0) }
    }

    /// One place earlier (`-1`) or later (`+1`).
    func move(_ id: Int, by offset: Int, api: APIClient) async {
        await reorder(api: api) { PortfolioReorder.moving(id, by: offset, in: $0) }
    }

    /// Shows the new order at once, then saves it; puts the old order back when saving fails.
    private func reorder(api: APIClient, _ transform: ([Int]) -> [Int]) async {
        guard canReorder, let current = photos.value else { return }
        let old = current.map(\.id)
        guard let body = PortfolioReorder.orderBody(employeeId: employee.id, old: old, new: transform(old)) else { return }
        isReordering = true
        defer { isReordering = false }
        photos.update { PortfolioReorder.arranged($0, by: body.ids) }
        do {
            photos.set(try await api.reorderPortfolio(employeeId: body.employeeId, ids: body.ids))
        } catch {
            photos.update { PortfolioReorder.arranged($0, by: old) }
            if !(error is CancellationError) { errorMessage = error.userMessage }
        }
    }

    // MARK: - Changes

    func delete(_ photo: PortfolioPhoto, api: APIClient) async {
        guard !deleting.contains(photo.id) else { return }
        deleting = deleting.union([photo.id])
        defer { deleting = deleting.subtracting([photo.id]) }
        do {
            try await api.deletePortfolioPhoto(id: photo.id)
            photos.remove(id: photo.id)
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.userMessage
        }
    }

    /// A photo saved in the editor keeps its place.
    func replace(_ photo: PortfolioPhoto) {
        photos.upsert(photo)
    }

    func remove(id: Int) {
        photos.remove(id: id)
    }
}
