import SwiftUI

/// «Расходы студии»: monthly bills (rent, electricity) and one-time purchases. They show in the analytics.
struct ExpensesView: View {
    @Environment(APIClient.self) private var api
    @State private var expenses = Remote<[StudioExpense]>()
    @State private var editor: Editor?

    private enum Editor: Identifiable {
        case new(ExpenseRepeat)
        case edit(StudioExpense)

        var id: String {
            switch self {
            case .new(let kind): "new-\(kind.rawValue)"
            case .edit(let expense): "edit-\(expense.id)"
            }
        }
    }

    private var today: String { CalendarDay.string(from: .now) }
    private var all: [StudioExpense] { expenses.value ?? [] }
    private var monthly: [StudioExpense] { all.filter { $0.repeatKind == .monthly && !$0.isEnded(today: today) } }
    private var ended: [StudioExpense] { all.filter { $0.isEnded(today: today) } }
    private var once: [StudioExpense] { all.filter { $0.repeatKind == .once } }
    private var monthlyTotal: Int { monthly.reduce(0) { $0 + $1.amount } }

    var body: some View {
        List {
            if !monthly.isEmpty {
                Section {
                    ForEach(monthly) { row($0) }
                } header: {
                    Text("Каждый месяц")
                } footer: {
                    Text("Итого в месяц: \(Money.format(monthlyTotal))")
                }
            }
            if !once.isEmpty {
                Section("Разовые") {
                    ForEach(once) { row($0) }
                }
            }
            if !ended.isEmpty {
                Section("Закончились") {
                    ForEach(ended) { row($0) }
                }
            }
        }
        .overlay {
            RemoteStateOverlay(remote: expenses, isEmpty: { $0.isEmpty }, retry: load) {
                ContentUnavailableView {
                    Label("Расходов пока нет", systemImage: "creditcard")
                } description: {
                    Text("Добавьте аренду, свет и другие платежи каждый месяц, а также разовые покупки — они попадут в отчёты.")
                } actions: {
                    Button("Добавить аренду") { editor = .new(.monthly) }
                        .buttonStyle(.borderedProminent)
                }
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .remoteErrorAlert(expenses)
        .navigationTitle("Расходы студии")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu("Добавить", systemImage: "plus") {
                    Button("Каждый месяц", systemImage: "arrow.clockwise") { editor = .new(.monthly) }
                    Button("Разовый", systemImage: "cart") { editor = .new(.once) }
                }
            }
        }
        .sheet(item: $editor) { editor in
            switch editor {
            case .new(let kind):
                ExpenseEditorSheet(expense: nil, newRepeat: kind, onSaved: saved)
            case .edit(let expense):
                ExpenseEditorSheet(expense: expense, onSaved: saved) { id in expenses.remove(id: id) }
            }
        }
    }

    private func row(_ expense: StudioExpense) -> some View {
        Button { editor = .edit(expense) } label: {
            ExpenseRow(expense: expense)
        }
        .foregroundStyle(.primary)
        .swipeActions(edge: .trailing) {
            Button("Удалить", systemImage: "trash", role: .destructive) { delete(expense) }
        }
    }

    private func saved(_ expense: StudioExpense) {
        expenses.upsert(expense)
        // The server's order: monthly first, newest first.
        Task { await load() }
    }

    private func delete(_ expense: StudioExpense) {
        expenses.remove(id: expense.id)
        Task {
            do {
                try await api.deleteExpense(id: expense.id)
            } catch {
                expenses.transientError = error.userMessage
                await load()
            }
        }
    }

    private func load() async {
        await expenses.load { try await api.expenses() }
    }
}

/// An expense in the list: category icon, name, when it is charged, the amount.
struct ExpenseRow: View {
    let expense: StudioExpense

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: expense.category.systemImage)
                .font(.body)
                .foregroundStyle(Color.accentColor)
                .frame(width: 32, height: 32)
                .background(Color.accentColor.opacity(0.12), in: .circle)
            VStack(alignment: .leading, spacing: 2) {
                Text(expense.name)
                    .font(.body)
                    .lineLimit(1)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                MoneyText(expense.amount).font(.body.weight(.semibold))
                if expense.repeatKind == .monthly {
                    Text("в месяц").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var detail: String {
        let date = CalendarDay.date(from: expense.date).map(DateText.fullDate) ?? expense.date
        let when: String
        switch expense.repeatKind {
        case .once:
            when = date
        case .monthly:
            let end = expense.endDate.flatMap { CalendarDay.date(from: $0) }.map { " по \(DateText.fullDate($0))" } ?? ""
            when = "с \(date)\(end)"
        }
        return [expense.category.title, when, expense.note].compactMap { $0 }.joined(separator: " · ")
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        ExpensesView()
    }
    .previewEnvironment()
}
#endif
