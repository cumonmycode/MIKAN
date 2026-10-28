import CoreTransferable
import Foundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

nonisolated enum SmmMediaTransferError: LocalizedError, Sendable {
    case unreadable
    case videoTooLarge

    var errorDescription: String? {
        switch self {
        case .unreadable: "Не удалось прочитать файл из медиатеки."
        case .videoTooLarge: "Видео больше 100 МБ — сократите или сожмите его."
        }
    }
}

/// Own photo or video from the library for a post (Titan `pickMedia` + `uploadAsset`): photos go as JPEG of a
/// sensible size, videos as is (the picker hands over H.264), up to the route's 100 MB.
nonisolated enum SmmMediaUpload {
    static let maxVideoBytes = 100 * 1024 * 1024
    /// Long side of an uploaded photo: enough for a 1080 px feed and a 4:5 crop.
    static let photoLongSide = 2048

    static func file(from item: PhotosPickerItem) async throws -> SmmUpload {
        let movieType = item.supportedContentTypes.first { $0.conforms(to: .movie) }
        guard let data = try await item.loadTransferable(type: Data.self) else {
            throw SmmMediaTransferError.unreadable
        }
        if let movieType {
            guard data.count <= maxVideoBytes else { throw SmmMediaTransferError.videoTooLarge }
            let isQuickTime = movieType.conforms(to: .quickTimeMovie)
            return SmmUpload.video(data: data, fileExtension: isQuickTime ? "mov" : "mp4")
        }
        let jpeg = try await jpegInBackground(data)
        return SmmUpload.photo(jpegData: jpeg)
    }

    @concurrent
    private static func jpegInBackground(_ data: Data) async throws -> Data {
        try ImagePreparer.jpeg(from: data, maxPixelSize: photoLongSide)
    }
}

/// A post's picture or video for the system share sheet («Сохранить изображение», Instagram, Telegram): downloaded
/// only when a target is picked (Titan `shareMedia`).
nonisolated struct SmmMediaFile: Sendable {
    let url: URL
    let isVideo: Bool

    fileprivate var fileName: String {
        let name = url.lastPathComponent
        return name.isEmpty ? (isVideo ? "mikan-video.mp4" : "mikan-photo.jpg") : name
    }

    fileprivate static func download(_ file: SmmMediaFile) async throws -> SentTransferredFile {
        let (temporary, response) = try await URLSession.shared.download(from: file.url)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw APIError.transport(message: "Файл не скачался (код \(http.statusCode)).")
        }
        let folder = FileManager.default.temporaryDirectory.appending(path: "smm-share", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appending(path: file.fileName)
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: temporary, to: destination)
        return SentTransferredFile(destination)
    }
}

extension SmmMediaFile: Transferable {
    nonisolated static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .mpeg4Movie) { file in try await download(file) }
            .exportingCondition { $0.isVideo }
        FileRepresentation(exportedContentType: .jpeg) { file in try await download(file) }
            .exportingCondition { !$0.isVideo }
    }
}
