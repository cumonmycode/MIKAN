import SwiftUI

/// A log line: who (an avatar, or a bot / server icon), when, and what changed.
struct AuditEntryRow: View {
    let entry: AuditEntry
    /// The section caption («Записи») — useful in the whole studio's log, not in a card's own history.
    var showsSection = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AuditActorIcon(entry: entry)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(AuditLogText.actor(of: entry))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Text(DateText.time(entry.at))
                        .font(.subheadline)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                Text(AuditLogText.summary(of: entry))
                    .fixedSize(horizontal: false, vertical: true)
                if showsSection {
                    Text(AuditLogText.sectionTitle(entry.entity))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

private struct AuditActorIcon: View {
    let entry: AuditEntry

    private static let size: CGFloat = 32

    var body: some View {
        if let employee = entry.employee {
            InitialsAvatar(name: employee.name, color: .master(employee.color), size: Self.size)
        } else {
            Image(systemName: entry.source.symbol)
                .font(.system(size: Self.size * 0.42, weight: .semibold))
                .foregroundStyle(entry.source.tint)
                .frame(width: Self.size, height: Self.size)
                .background(entry.source.tint.opacity(0.16), in: .circle)
                .accessibilityHidden(true)
        }
    }
}

private extension AuditSource {
    /// Icon of an entry without an employee.
    var symbol: String {
        switch self {
        case .app, .botStaff: "person.fill"
        case .bot: "paperplane.fill"
        case .online: "globe"
        case .system, .other: "gearshape.fill"
        }
    }

    var tint: Color {
        self == .bot || self == .online ? .blue : .gray
    }
}

#if DEBUG
private enum AuditPreviewData {
    static let entries: [AuditEntry] = [
        AuditEntry(
            id: 4, at: .now, employee: PreviewData.anna.ref, source: .app, action: "appointment.update",
            entity: "appointment", entityId: 1846,
            summary: "Запись №1846 (Анна Иванова) перенесена с 20 октября, 14:00 на 21 октября, 15:00"
        ),
        AuditEntry(
            id: 3, at: .now.addingTimeInterval(-3_600), employee: PreviewData.oleg.ref, source: .botStaff,
            action: "appointment.confirm", entity: "appointment", entityId: 1847, summary: "Запись №1847 (Иван Петров) подтверждена"
        ),
        AuditEntry(
            id: 2, at: .now.addingTimeInterval(-7_200), employee: nil, source: .bot, action: "booking.create",
            entity: "bot", entityId: 12, summary: "Заявка №12 (Мария Ким): прокол хеликса, в субботу после 15:00"
        ),
        AuditEntry(
            id: 1, at: .now.addingTimeInterval(-90_000), employee: nil, source: .system, action: "deposit.retain",
            entity: "deposit", entityId: 1840, summary: "Предоплата по записи №1840 удержана: 2 000 ₽"
        ),
    ]
}

#Preview {
    List {
        ForEach(AuditPreviewData.entries) { entry in
            AuditEntryRow(entry: entry, showsSection: true)
        }
    }
}
#endif
