import SwiftUI

/// When a scheduled campaign may start.
nonisolated enum CampaignSchedule {
    /// A start this close to now is «send now», not a schedule.
    static let minimumLead: TimeInterval = 5 * 60
    private static let step = 15 * 60

    /// The first quarter of an hour at least an hour from `now`.
    static func suggestedDate(now: Date = .now) -> Date {
        let target = now.addingTimeInterval(3600).timeIntervalSinceReferenceDate
        let rounded = (target / Double(step)).rounded(.up) * Double(step)
        return Date(timeIntervalSinceReferenceDate: rounded)
    }

    /// The server takes a start at most a year ahead.
    static let maximumLead: TimeInterval = 365 * 24 * 3600

    static func earliest(now: Date = .now) -> Date {
        now.addingTimeInterval(minimumLead)
    }

    static func latest(now: Date = .now) -> Date {
        now.addingTimeInterval(maximumLead)
    }

    static func isValid(_ date: Date, now: Date = .now) -> Bool {
        date >= earliest(now: now) && date <= latest(now: now)
    }
}

/// «Запланировать»: picks the start of a campaign.
struct CampaignScheduleSheet: View {
    @Environment(\.dismiss) private var dismiss
    let recipients: Int?
    let onSchedule: (Date) -> Void

    @State private var date: Date

    init(current: Date?, recipients: Int?, onSchedule: @escaping (Date) -> Void) {
        self.recipients = recipients
        self.onSchedule = onSchedule
        let initial = current.flatMap { CampaignSchedule.isValid($0) ? $0 : nil } ?? CampaignSchedule.suggestedDate()
        _date = State(initialValue: initial)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("Начало", selection: $date, in: CampaignSchedule.earliest()...CampaignSchedule.latest(), displayedComponents: [.date, .hourAndMinute])
                        .datePickerStyle(.graphical)
                } footer: {
                    Text(footer)
                }
            }
            .navigationTitle("Запланировать")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Готово") {
                        onSchedule(date)
                        dismiss()
                    }
                    .disabled(!CampaignSchedule.isValid(date))
                }
            }
        }
    }

    private var footer: String {
        let who = recipients.map { "Получат примерно \(CampaignPresentation.clients($0)) — список зафиксируется в момент отправки. " } ?? ""
        return who + "Время — по часам этого телефона."
    }
}

#if DEBUG
#Preview {
    CampaignScheduleSheet(current: nil, recipients: 124) { _ in }
}
#endif
