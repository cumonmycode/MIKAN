import Foundation
import Observation
import os

nonisolated enum HTTPMethod: String, Sendable {
    case get = "GET"
    case post = "POST"
    case patch = "PATCH"
    case put = "PUT"
    case delete = "DELETE"
}

/// Single HTTP client for the MIKAN API: JSON coding, Bearer auth, error mapping and uploads.
@Observable
final class APIClient {
    /// Server origin, e.g. `https://95-170-124-192.sslip.io` (the API lives under `/api`).
    private(set) var serverURL: URL
    @ObservationIgnored private(set) var token: String?
    /// Called on any 401 for an authenticated request (session expired or employee deactivated).
    @ObservationIgnored var onUnauthorized: (() -> Void)?
    /// The offline mode: hears whether each request got an answer; while offline, writes are refused unsent.
    @ObservationIgnored var connectivity: Connectivity?
    /// The phone's copy of the main data, served by some GETs while offline (`APIClient+Offline`).
    @ObservationIgnored var offlineCache: OfflineCache?

    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private let encoder = JSONCoding.makeEncoder()
    @ObservationIgnored private let decoder = JSONCoding.makeDecoder()
    @ObservationIgnored private let logger = Logger(subsystem: "com.mikanstudio.crm", category: "api")

    static let requestTimeout: TimeInterval = 20
    static let uploadTimeout: TimeInterval = 60
    /// Videos up to 100 MB over a mobile uplink.
    static let videoUploadTimeout: TimeInterval = 600
    /// AI picture generation answers in 1–2 minutes.
    static let imageGenerationTimeout: TimeInterval = 240

    init(serverURL: URL, token: String? = nil, session: URLSession? = nil) {
        self.serverURL = serverURL
        self.token = token
        self.session = session ?? APIClient.makeSession()
    }

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = requestTimeout
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }

    func updateServer(_ url: URL) { serverURL = url }
    func updateToken(_ token: String?) { self.token = token }

    /// Absolute URL for server-relative media paths such as `/uploads/x.jpg`.
    func mediaURL(for path: String?) -> URL? {
        guard let path = path.nonEmpty else { return nil }
        if path.hasPrefix("http://") || path.hasPrefix("https://") { return URL(string: path) }
        let separator = path.hasPrefix("/") ? "" : "/"
        return URL(string: serverURL.absoluteString + separator + path)
    }

    // MARK: - Requests

    func request<T: Decodable>(
        _ method: HTTPMethod,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (any Encodable)? = nil,
        idempotencyKey: UUID? = nil,
        timeout: TimeInterval = APIClient.requestTimeout,
        headers: [String: String] = [:]
    ) async throws -> T {
        let payload = try body.map { try encoder.encode($0) }
        let data = try await send(
            method, path, query: query, body: payload,
            contentType: "application/json", timeout: timeout, idempotencyKey: idempotencyKey, headers: headers
        )
        return try decode(T.self, from: data, path: path)
    }

    /// For endpoints answering `204 No Content` (or whose body is irrelevant).
    func requestVoid(_ method: HTTPMethod, _ path: String, body: (any Encodable)? = nil) async throws {
        let payload = try body.map { try encoder.encode($0) }
        _ = try await send(method, path, query: [], body: payload, contentType: "application/json")
    }

    /// For endpoints answering with a file instead of JSON.
    func requestData(_ method: HTTPMethod, _ path: String) async throws -> Data {
        try await send(method, path, query: [], body: nil, contentType: "application/json")
    }

    /// `POST /uploads` with a `multipart/form-data` field `file`.
    func uploadImage(jpegData: Data, filename: String = "photo.jpg") async throws -> LinkResponse {
        try await upload("uploads", data: jpegData, filename: filename, mimeType: "image/jpeg")
    }

    /// `POST <path>` with one `multipart/form-data` field `file` (photo or video) and a JSON answer.
    func upload<T: Decodable>(
        _ path: String,
        data fileData: Data,
        filename: String,
        mimeType: String,
        timeout: TimeInterval = APIClient.uploadTimeout
    ) async throws -> T {
        let boundary = "MIKAN-\(UUID().uuidString)"
        let head = "--\(boundary)\r\n"
            + "Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n"
            + "Content-Type: \(mimeType)\r\n\r\n"
        let tail = "\r\n--\(boundary)--\r\n"
        var body = Data(capacity: fileData.count + head.utf8.count + tail.utf8.count)
        body.append(Data(head.utf8))
        body.append(fileData)
        body.append(Data(tail.utf8))
        let data = try await send(
            .post, path, query: [], body: body,
            contentType: "multipart/form-data; boundary=\(boundary)",
            timeout: timeout
        )
        return try decode(T.self, from: data, path: path)
    }

    // MARK: - Transport

    private func send(
        _ method: HTTPMethod,
        _ path: String,
        query: [URLQueryItem],
        body: Data?,
        contentType: String,
        timeout: TimeInterval = APIClient.requestTimeout,
        idempotencyKey: UUID? = nil,
        headers: [String: String] = [:]
    ) async throws -> Data {
        try OfflineWriteGuard.check(method, path: path, isOnline: connectivity?.isOnline ?? true)
        let request = try makeRequest(
            method, path, query: query, body: body,
            contentType: contentType, timeout: timeout, idempotencyKey: idempotencyKey, headers: headers
        )
        let (data, response) = try await perform(request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport(message: "Некорректный ответ сервера.")
        }
        if OfflineWriteGuard.isUnreachable(status: http.statusCode, body: data) {
            connectivity?.serverUnreachable()
        } else {
            connectivity?.serverAnswered()
        }
        guard (200..<300).contains(http.statusCode) else {
            let error = APIError.from(status: http.statusCode, data: data)
            logger.notice("\(method.rawValue, privacy: .public) \(path, privacy: .public) → \(http.statusCode)")
            if http.statusCode == 401, path != "auth/login", token != nil {
                onUnauthorized?()
            }
            throw error
        }
        return data
    }

    private func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            logger.error("Network error: \(error.localizedDescription, privacy: .public)")
            if OfflineWriteGuard.isUnreachable(error.code) { connectivity?.serverUnreachable() }
            throw APIError.from(error)
        }
    }

    /// Internal (not private) so tests can check the headers.
    func makeRequest(
        _ method: HTTPMethod,
        _ path: String,
        query: [URLQueryItem],
        body: Data?,
        contentType: String,
        timeout: TimeInterval,
        idempotencyKey: UUID? = nil,
        headers: [String: String] = [:]
    ) throws -> URLRequest {
        let endpoint = serverURL.appending(path: "api").appending(path: path)
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidServerAddress
        }
        if !query.isEmpty {
            components.percentEncodedQueryItems = query.map {
                URLQueryItem(name: $0.name, value: $0.value?.addingPercentEncoding(withAllowedCharacters: .apiQueryValue))
            }
        }
        guard let url = components.url else { throw APIError.invalidServerAddress }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let idempotencyKey {
            request.setValue(idempotencyKey.uuidString, forHTTPHeaderField: "Idempotency-Key")
        }
        for (field, value) in headers {
            request.setValue(value, forHTTPHeaderField: field)
        }
        if let body {
            request.httpBody = body
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data, path: String) throws -> T {
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            logger.error("Decoding \(path, privacy: .public) failed: \(String(describing: error), privacy: .public)")
            throw APIError.decoding
        }
    }
}

nonisolated extension CharacterSet {
    /// Unreserved characters only, so `+`, `&`, `=` and `:` in values are always percent-encoded.
    static let apiQueryValue = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
}

/// Builds query items, dropping `nil` values.
nonisolated func queryItems(_ pairs: KeyValuePairs<String, String?>) -> [URLQueryItem] {
    pairs.compactMap { name, value in value.map { URLQueryItem(name: name, value: $0) } }
}
