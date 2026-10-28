import SwiftUI

/// A waitlist entry: the client, the services, the master or «Любой мастер», the dates, where it came from, the note
/// and, once told about freed time, when.
struct WaitlistRow: View {
    let entry: WaitlistEntry
    var isCancelling = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(entry.client.fullName)
                    .font(.headline)
                Spacer(minLength: 8)
                if isCancelling {
                    ProgressView()
                } else {
                    StatusBadge(text: WaitlistText.channel(entry.channel), color: .secondary, systemImage: entry.channel.symbol)
                }
            }
            Text(WaitlistText.services(entry.items))
                .font(.subheadline)
            HStack(spacing: 12) {
                Label(WaitlistText.range(from: entry.dateFrom, to: entry.dateTo), systemImage: "calendar")
                Label(WaitlistText.master(entry.master), systemImage: entry.master == nil ? "person.2" : "person")
                    .lineLimit(1)
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            if entry.status == .notified, let notifiedAt = entry.notifiedAt {
                Label(WaitlistText.notified(notifiedAt), systemImage: "bell.badge")
                    .font(.caption)
                    .foregroundStyle(WaitlistStatus.notified.color)
            }
            if entry.status == .booked, entry.appointmentId != nil {
                Label("Клиент записался — откройте запись", systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(WaitlistStatus.booked.color)
            }
            if let note = entry.note.nonEmpty {
                Text(note)
                    .font(.footnote)
                    .italic()
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
#Preview {
    List {
        WaitlistRow(entry: WaitlistEntry(
            id: 1,
            client: ClientRef(id: 1, name: "Анна", lastName: "Иванова", phone: "+79990000001", telegramLinked: true),
            items: [WaitlistItem(serviceId: 1, variant: "Два", name: "Мочка")],
            master: nil,
            dateFrom: "2026-10-21",
            dateTo: "2026-10-25",
            status: .notified,
            channel: .web,
            notifiedAt: .now,
            appointmentId: nil,
            note: "Лучше после обеда",
            createdAt: .now
        ))
    }
}
#endif
