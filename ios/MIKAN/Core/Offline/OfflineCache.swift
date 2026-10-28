import Foundation
import os

/// One dataset the phone keeps for working without a network (docs/API.md «Offline mode (app)»).
nonisolated enum OfflineDataset: Hashable, Sendable {
    /// Today ± 7 days of every master (`ScheduleSnapshot`).
    case schedule
    /// The active clients the list screen loaded (`ClientsSnapshot`).
    case clients
    case services(includeInactive: Bool)
    /// Products of one kind, with their sizes.
    case products(kind: ProductKind, includeInactive: Bool)
    case categories
    case employees(includeInactive: Bool)
    case studioSettings
    case botSettings

    var fileName: String {
        switch self {
        case .schedule: "schedule.json"
        case .clients: "clients.json"
        case .services(let all): all ? "services-all.json" : "services.json"
        case .products(let kind, let all): "products-\(kind.rawValue)\(all ? "-all" : "").json"
        case .categories: "categories.json"
        case .employees(let all): all ? "employees-all.json" : "employees.json"
        case .studioSettings: "studio-settings.json"
        case .botSettings: "bot-settings.json"
        }
    }
}

/// A saved copy: what was loaded, the format it was written in and when.
nonisolated struct OfflineEnvelope<Payload: Codable & Sendable>: Codable, Sendable {
    let version: Int
    let savedAt: Date
    let payload: Payload
}

/// JSON of the saved copies, with the API's date format. A copy written in another format is ignored, so a model that
/// changed shape is never misread.
nonisolated enum OfflineCoding {
    /// Bump whenever a cached model changes shape.
    static let currentVersion = 1

    private struct Header: Decodable {
        let version: Int
        let savedAt: Date
    }

    static func encode<Payload: Codable & Sendable>(
        _ payload: Payload, savedAt: Date, version: Int = currentVersion
    ) throws -> Data {
        try JSONCoding.makeEncoder().encode(OfflineEnvelope(version: version, savedAt: savedAt, payload: payload))
    }

    /// The copy, or `nil` when it was written in another format version; throws when the file does not read at all.
    static func decode<Payload: Codable & Sendable>(
        _ type: Payload.Type, from data: Data, version: Int = currentVersion
    ) throws -> OfflineEnvelope<Payload>? {
        guard try savedAt(of: data, version: version) != nil else { return nil }
        return try JSONCoding.makeDecoder().decode(OfflineEnvelope<Payload>.self, from: data)
    }

    /// When the copy was saved, or `nil` for another format version (the payload is not read).
    static func savedAt(of data: Data, version: Int = currentVersion) throws -> Date? {
        let header = try JSONCoding.makeDecoder().decode(Header.self, from: data)
        return header.version == version ? header.savedAt : nil
    }
}

/// The phone's copy of the main data: one JSON file per dataset in Application Support (excluded from backups,
/// readable after the first unlock of the iPhone), written atomically off the main thread.
///
/// Closed — nothing is read or written — until the signed-in app is unlocked (`open`), so nothing saved shows before
/// Face ID; wiped on sign-out, since another employee may sign in on this phone.
actor OfflineCache {
    private let directory: URL
    private var isOpen = false
    /// When each dataset was last written: an older answer arriving late never overwrites a newer copy.
    private var lastSaved: [OfflineDataset: Date] = [:]
    private let logger = Logger(subsystem: "com.mikanstudio.crm", category: "offline")

    init(directory: URL = OfflineCache.defaultDirectory) {
        self.directory = directory
    }

    nonisolated static var defaultDirectory: URL {
        URL.applicationSupportDirectory.appending(path: "OfflineCache", directoryHint: .isDirectory)
    }

    /// Opens the copy for the signed-in, unlocked session. `false` when it was already open.
    func open() -> Bool {
        guard !isOpen else { return false }
        isOpen = true
        return true
    }

    /// Closes the copy and deletes it.
    func wipe() {
        isOpen = false
        lastSaved = [:]
        guard exists(directory) else { return }
        do {
            try FileManager.default.removeItem(at: directory)
        } catch {
            logger.error("Wiping the offline copy failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func save<Payload: Codable & Sendable>(_ payload: Payload, as dataset: OfflineDataset, at date: Date = .now) {
        guard isOpen else { return }
        if let last = lastSaved[dataset], last > date { return }
        do {
            try prepareDirectory()
            let data = try OfflineCoding.encode(payload, savedAt: date)
            try data.write(to: url(for: dataset), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            lastSaved[dataset] = date
        } catch {
            logger.error("Saving \(dataset.fileName, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Reads, changes and writes a copy in one step (lists saved page by page).
    func update<Payload: Codable & Sendable>(
        _ type: Payload.Type,
        _ dataset: OfflineDataset,
        at date: Date = .now,
        _ transform: @Sendable (Payload?) -> Payload
    ) {
        guard isOpen else { return }
        save(transform(load(type, dataset)?.payload), as: dataset, at: date)
    }

    /// The saved copy; `nil` while closed, when there is none, or when it is in another format (then it is removed).
    func load<Payload: Codable & Sendable>(_ type: Payload.Type, _ dataset: OfflineDataset) -> OfflineEnvelope<Payload>? {
        guard isOpen else { return nil }
        let url = url(for: dataset)
        guard exists(url) else { return nil }
        do {
            guard let envelope = try OfflineCoding.decode(type, from: Data(contentsOf: url)) else {
                logger.notice("Dropping \(dataset.fileName, privacy: .public) of another format")
                remove(url)
                return nil
            }
            return envelope
        } catch {
            logger.error("Reading \(dataset.fileName, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            remove(url)
            return nil
        }
    }

    /// The newest save among the copies (for «данные на 14:32»); copies of another format are removed.
    func newestSavedAt() -> Date? {
        guard isOpen, exists(directory) else { return nil }
        do {
            let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            return files.compactMap { savedAt(of: $0) }.max()
        } catch {
            logger.error("Listing the offline copy failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    // MARK: Files

    private func url(for dataset: OfflineDataset) -> URL {
        directory.appending(path: dataset.fileName, directoryHint: .notDirectory)
    }

    private func savedAt(of file: URL) -> Date? {
        do {
            guard let date = try OfflineCoding.savedAt(of: Data(contentsOf: file)) else {
                remove(file)
                return nil
            }
            return date
        } catch {
            logger.error("Reading \(file.lastPathComponent, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            remove(file)
            return nil
        }
    }

    private func prepareDirectory() throws {
        guard !exists(directory) else { return }
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var folder = directory
        try folder.setResourceValues(values)
    }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path(percentEncoded: false))
    }

    private func remove(_ url: URL) {
        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            logger.error("Removing \(url.lastPathComponent, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
