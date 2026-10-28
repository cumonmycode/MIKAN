import Foundation

/// Texts of the audit log rows, sections and filters.
nonisolated enum AuditLogText {
    /// Who did it, shown above the summary: «Анна», «Анна · через бота», «Клиент в боте», «Клиент онлайн»,
    /// «Автоматически».
    static func actor(of entry: AuditEntry) -> String {
        let employee = entry.employee?.name.nonEmpty
        switch entry.source {
        case .app: return employee ?? "Сотрудник"
        case .botStaff: return "\(employee ?? "Сотрудник") · через бота"
        case .bot: return "Клиент в боте"
        case .online: return "Клиент онлайн"
        case .system: return "Автоматически"
        case .other: return employee ?? "Автоматически"
        }
    }

    /// The summary, or the raw action for a row that came without one.
    static func summary(of entry: AuditEntry) -> String {
        entry.summary.nonEmpty ?? entry.action
    }

    /// «Записи», or the raw value of an entity this build does not know.
    static func sectionTitle(_ entity: String) -> String {
        AuditSection(rawValue: entity)?.title ?? entity
    }

    /// «Сегодня», «Вчера», «15 октября», or with the year for another year: «15 октября 2025 г.».
    static func dayTitle(_ day: Date, now: Date = .now, calendar: Calendar = .app) -> String {
        if calendar.isDate(day, inSameDayAs: now) { return "Сегодня" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(day, inSameDayAs: yesterday) {
            return "Вчера"
        }
        return calendar.isDate(day, equalTo: now, toGranularity: .year) ? DateText.dayMonth(day) : DateText.fullDate(day)
    }

    /// Employees in the filter: active ones first, then alphabetically (a disabled employee still has history).
    static func filterEmployees(_ employees: [Employee]) -> [Employee] {
        employees.sorted { lhs, rhs in
            if lhs.active != rhs.active { return lhs.active }
            return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
    }

    /// The employee filter chip; «Сотрудник» until the employees load.
    static func employeeName(_ id: Int, in employees: [Employee]) -> String {
        employees.first { $0.id == id }?.name ?? "Сотрудник"
    }
}

/// The entries of one calendar day: a section of the log.
nonisolated struct AuditDay: Identifiable, Hashable, Sendable {
    let start: Date
    let entries: [AuditEntry]

    var id: Date { start }

    /// Newest day first; inside a day the entries keep the server's order (newest first).
    static func grouping(_ entries: [AuditEntry], calendar: Calendar = .app) -> [AuditDay] {
        let grouped = Dictionary(grouping: entries) { calendar.startOfDay(for: $0.at) }
        return grouped.keys.sorted(by: >).map { day in AuditDay(start: day, entries: grouped[day] ?? []) }
    }
}
