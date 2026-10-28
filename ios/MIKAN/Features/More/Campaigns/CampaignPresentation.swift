import SwiftUI

/// How the app names and colours campaign states.
nonisolated enum CampaignPresentation {
    /// The bot adds it under every campaign message (sets `marketingOptOut`).
    static let optOutButtonTitle = "🔕 Не присылать новости"

    /// «1 клиент», «5 клиентов».
    static func clients(_ count: Int) -> String {
        Plural.count(count, one: "клиент", few: "клиента", many: "клиентов")
    }

    /// «1 клиенту», «5 клиентам» — after «отправить».
    static func clientsDative(_ count: Int) -> String {
        "\(count) " + Plural.word(count, one: "клиенту", few: "клиентам", many: "клиентам")
    }

    /// The inline buttons a client sees under the message.
    static func buttons(_ button: CampaignButton?) -> [String] {
        [button?.text.nonEmpty, optOutButtonTitle].compactMap { $0 }
    }

    /// «Отправлено 120 из 124», «Получателей: 124».
    static func progressLine(_ stats: CampaignStats, status: CampaignStatus) -> String? {
        switch status {
        case .sending, .sent, .cancelled:
            guard stats.recipients > 0 else { return status == .sending ? "Готовим отправку…" : nil }
            return "Доставлено \(stats.sent) из \(stats.recipients)"
        case .draft, .scheduled, .unknown:
            return nil
        }
    }

    /// The date that matters for the state: when it is scheduled, sent, stopped or last changed.
    static func dateLine(_ campaign: Campaign) -> String {
        switch campaign.status {
        case .scheduled:
            campaign.scheduledAt.map { "Отправка \(DateText.dateTime($0))" } ?? "Запланирована"
        case .sending:
            campaign.startedAt.map { "Началась \(DateText.dateTime($0))" } ?? "Отправляется"
        case .sent:
            (campaign.finishedAt ?? campaign.startedAt).map { "Отправлена \(DateText.dateTime($0))" } ?? "Отправлена"
        case .cancelled:
            "Остановлена \(DateText.dateTime(campaign.finishedAt ?? campaign.updatedAt))"
        case .draft, .unknown:
            "Изменена \(DateText.dateTime(campaign.updatedAt))"
        }
    }
}

extension CampaignStatus {
    var title: String {
        switch self {
        case .draft: "Черновик"
        case .scheduled: "Запланирована"
        case .sending: "Отправляется"
        case .sent: "Отправлена"
        case .cancelled: "Остановлена"
        case .unknown: "Неизвестно"
        }
    }

    var color: Color {
        switch self {
        case .draft, .unknown: .gray
        case .scheduled: .blue
        case .sending: .orange
        case .sent: .green
        case .cancelled: .red
        }
    }

    var symbol: String {
        switch self {
        case .draft: "pencil"
        case .scheduled: "clock"
        case .sending: "paperplane"
        case .sent: "checkmark"
        case .cancelled: "xmark"
        case .unknown: "questionmark"
        }
    }
}
