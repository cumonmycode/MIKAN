import Foundation

/// The expense form: a monthly bill (rent, electricity) or a one-time purchase (a wardrobe).
nonisolated struct ExpenseDraft: Hashable, Sendable {
    var name = ""
    var category: ExpenseCategory = .rent
    var amount = 0
    var repeatKind: ExpenseRepeat = .monthly
    var date: Date
    var hasEndDate = false
    var endDate: Date
    var note = ""

    init(repeatKind: ExpenseRepeat = .monthly, today: Date = .now) {
        self.repeatKind = repeatKind
        category = repeatKind == .monthly ? .rent : .furniture
        date = today
        endDate = today
    }

    init(_ expense: StudioExpense, calendar: Calendar = .app) {
        let start = CalendarDay.date(from: expense.date, calendar: calendar) ?? .now
        name = expense.name
        category = expense.category
        amount = expense.amount
        repeatKind = expense.repeatKind
        date = start
        hasEndDate = expense.endDate != nil
        endDate = expense.endDate.flatMap { CalendarDay.date(from: $0, calendar: calendar) } ?? start
        note = expense.note ?? ""
    }

    /// The first thing to fix before saving, or `nil`.
    func problem(calendar: Calendar = .app) -> String? {
        if name.trimmed.isEmpty { return "Укажите название." }
        if amount <= 0 { return "Укажите сумму больше нуля." }
        if repeatKind == .monthly && hasEndDate
            && CalendarDay.string(from: endDate, calendar: calendar) < CalendarDay.string(from: date, calendar: calendar) {
            return "Дата окончания раньше даты начала."
        }
        return nil
    }

    func body(calendar: Calendar = .app) -> ExpenseBody {
        let note = note.trimmed
        return ExpenseBody(
            name: name.trimmed,
            category: category,
            amount: amount,
            repeatKind: repeatKind,
            date: CalendarDay.string(from: date, calendar: calendar),
            endDate: repeatKind == .monthly && hasEndDate ? CalendarDay.string(from: endDate, calendar: calendar) : nil,
            note: note.isEmpty ? nil : note
        )
    }

    /// Under the date: when it is charged.
    func dateHint(calendar: Calendar = .app) -> String {
        switch repeatKind {
        case .once:
            return "Попадёт в отчёт за \(DateText.fullDate(date))."
        case .monthly:
            let day = calendar.component(.day, from: date)
            let shorter = day > 28 ? " (в коротком месяце — в последний день)" : ""
            return "Каждый месяц \(day)-го числа\(shorter), начиная с \(DateText.fullDate(date))."
        }
    }
}
