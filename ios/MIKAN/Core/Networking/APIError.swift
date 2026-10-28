import Foundation

/// Error envelope: `{ "error": { "code": "...", "message": "..." } }`.
nonisolated struct APIErrorEnvelope: Decodable, Sendable {
    struct Body: Decodable, Sendable {
        let code: String
        let message: String
    }

    let error: Body
}

nonisolated enum APIError: Error, Equatable, LocalizedError, Sendable {
    /// Non-2xx response. `message` is human-readable Russian, shown as is.
    case server(status: Int, code: String, message: String)
    /// `outcomeUnknown`: the request may have reached the server (timeout, dropped connection).
    case transport(message: String, outcomeUnknown: Bool = false)
    case decoding
    case invalidServerAddress
    /// A write refused before it was sent: the app is offline (`OfflineWriteGuard`), nothing reached the server.
    case offline

    var message: String {
        switch self {
        case .server(_, _, let message): message
        case .transport(let message, _): message
        case .decoding: "Не удалось обработать ответ сервера. Возможно, приложение нужно обновить."
        case .invalidServerAddress: "Неверный адрес сервера. Пример: https://studio.example.ru"
        case .offline: "Нужен интернет. Без сети данные можно только смотреть."
        }
    }

    var errorDescription: String? { message }

    var code: String? {
        if case .server(_, let code, _) = self { return code }
        return nil
    }

    var status: Int? {
        if case .server(let status, _, _) = self { return status }
        return nil
    }

    var isScheduleConflict: Bool { code == "schedule_conflict" }

    /// The server may or may not have applied the request (timeout, dropped connection). Writes sent with an
    /// `IdempotencyKey` (sale, refund, cash operation, stock movement) are safe to resend with the same key.
    var isOutcomeUnknown: Bool {
        if case .transport(_, true) = self { return true }
        return false
    }
    var isUnauthorized: Bool { status == 401 }

    /// Maps a non-2xx HTTP response to an error, preferring the server's envelope.
    static func from(status: Int, data: Data) -> APIError {
        if let envelope = try? JSONDecoder().decode(APIErrorEnvelope.self, from: data) {
            return .server(status: status, code: envelope.error.code, message: envelope.error.message)
        }
        return .server(status: status, code: fallbackCode(for: status), message: fallbackMessage(for: status))
    }

    static func from(_ error: URLError) -> APIError {
        switch error.code {
        case .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff:
            .transport(message: "Нет подключения к интернету.")
        case .networkConnectionLost:
            .transport(message: "Связь с сервером прервалась.", outcomeUnknown: true)
        case .timedOut:
            .transport(message: "Сервер не отвечает. Попробуйте ещё раз.", outcomeUnknown: true)
        case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .badURL, .unsupportedURL:
            .transport(message: "Не удалось подключиться к серверу. Проверьте адрес сервера.")
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot:
            .transport(message: "Не удалось установить защищённое соединение с сервером.")
        case .appTransportSecurityRequiresSecureConnection:
            .transport(message: "Сервер должен работать по HTTPS.")
        default:
            .transport(message: "Ошибка сети. Попробуйте ещё раз.")
        }
    }

    private static func fallbackCode(for status: Int) -> String {
        switch status {
        case 400: "validation_error"
        case 401: "unauthorized"
        case 403: "forbidden"
        case 404: "not_found"
        case 409: "conflict"
        case 429: "rate_limited"
        default: "internal"
        }
    }

    private static func fallbackMessage(for status: Int) -> String {
        switch status {
        case 400: "Проверьте введённые данные."
        case 401: "Требуется вход в аккаунт."
        case 403: "Недостаточно прав."
        case 404: "Не найдено."
        case 409: "Конфликт данных. Обновите экран и попробуйте снова."
        case 429: "Слишком много попыток. Подождите минуту."
        default: "Ошибка сервера (\(status)). Попробуйте позже."
        }
    }
}

nonisolated extension Error {
    /// Text to show the user: the server's message for API errors.
    var userMessage: String {
        if let apiError = self as? APIError { return apiError.message }
        if let localized = self as? LocalizedError, let description = localized.errorDescription {
            return description
        }
        return "Что-то пошло не так. Попробуйте ещё раз."
    }
}
