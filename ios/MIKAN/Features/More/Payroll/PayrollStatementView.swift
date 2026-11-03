import SwiftUI

/// One employee's statement for a period: totals, what it is made of, adjustments and lines. The owner adds and
/// deletes adjustments here; everyone may open the pay rules behind it.
struct PayrollStatementView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppState.self) private var appState

    let employee: EmployeeRef
    @State private var selection: PayrollPeriodSelection
    @State private var statement = Remote<PayrollStatement>()
    @State private var addsAdjustment = false
    @State private var deleting: PayrollAdjustment?
    @State private var errorMessage: String?
    /// The period on screen: cleared only for another period, not when the screen reappears (see PayrollListView).
    @State private var shownRange: PayrollRange?
    /// «Сегодня» card on one's own statement, loaded apart from the period.
    @State private var today = Remote<PayrollList>()

    init(employee: EmployeeRef, selection: PayrollPeriodSelection) {
        self.employee = employee
        _selection = State(initialValue: selection)
    }

    private var canManage: Bool { appState.employee?.role == .owner }
    private var isSelf: Bool { appState.employee?.id == employee.id }
    private var range: PayrollRange { selection.range() }
    /// Only on one's own statement, and not twice when the period is today already.
    private var showsToday: Bool { isSelf && selection.option != .today }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                PayrollPeriodHeader(selection: $selection)
                if showsToday {
                    PayrollTodayCard(today: today, employeeId: employee.id, onDetails: showToday, retry: loadToday)
                }
                if let value = statement.value {
                    PayrollStatementContent(
                        statement: value,
                        canManage: canManage,
                        onAdd: { addsAdjustment = true },
                        onDelete: { deleting = $0 }
                    )
                } else if let failure = statement.failure {
                    ErrorStateView(message: failure, retry: load)
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 240)
                }
                rulesLink
            }
            .padding(16)
        }
        .background { AuraBackground() }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .refreshable {
            async let day: Void = loadToday()
            await load()
            await day
        }
        .task(id: range) {
            if shownRange != range { statement.reset() }
            shownRange = range
            await load()
        }
        .task { await loadToday() }
        .remoteErrorAlert(statement)
        .errorAlert($errorMessage)
        .toolbar {
            if canManage {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Добавить начисление или выплату", systemImage: "plus") { addsAdjustment = true }
                }
            }
        }
        .sheet(isPresented: $addsAdjustment) {
            PayrollAdjustmentSheet(employee: employee) { _ in
                Task { await load() }
            }
        }
        .confirmationDialog(
            deleting.map { "Удалить «\($0.kind.title)» на \(Money.format($0.amount))?" } ?? "",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible,
            presenting: deleting
        ) { adjustment in
            Button("Удалить", role: .destructive) { delete(adjustment) }
            Button("Отмена", role: .cancel) {}
        } message: { adjustment in
            if adjustment.cashOperationId != nil {
                Text("Деньги, выданные из кассы, останутся в смене — при необходимости внесите их обратно в кассе.")
            }
        }
        .navigationTitle(isSelf ? "Зарплата" : employee.name)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var rulesLink: some View {
        NavigationLink {
            PayRulesView(employee: employee)
        } label: {
            HStack {
                Label("Как считается зарплата", systemImage: "slider.horizontal.3")
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .cardStyle(padding: 14)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private func load() async {
        let range = range
        await statement.load { try await api.payrollStatement(employeeId: employee.id, from: range.from, to: range.to) }
    }

    private func loadToday() async {
        guard isSelf else { return }
        await today.loadToday(api: api)
    }

    private func showToday() {
        withAnimation(.snappy) { selection.option = .today }
    }

    private func delete(_ adjustment: PayrollAdjustment) {
        Task {
            do {
                try await api.deletePayrollAdjustment(id: adjustment.id)
                await load()
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        PayrollStatementView(employee: PreviewData.anna.ref, selection: PayrollPeriodSelection())
    }
    .previewEnvironment()
}
#endif
