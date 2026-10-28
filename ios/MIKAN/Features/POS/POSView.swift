import SwiftUI

/// «Касса» hub: the shift strip, «К оплате» — open receipts of every device and today's visits not started yet in one
/// list — and the big «Новая продажа». A card opens its receipt over the hub (`receiptFlow`).
struct POSView: View {
    @Environment(AppState.self) private var appState
    @Environment(APIClient.self) private var api
    @Environment(CartStore.self) private var cart
    @Environment(ShiftStore.self) private var shift
    @Environment(OpenReceiptsStore.self) private var receipts

    @State private var queue = Remote<[Appointment]>()
    @State private var opening: POSOpening?
    @State private var deletion: ReceiptDeletion?
    @State private var showsReceipt = false
    /// «Мои / Все» picked by hand; `nil` — the default for the employee (`PaymentDueList.defaultScope`).
    @State private var pickedScope: PaymentDueScope?
    @State private var errorMessage: String?
    @State private var errorTitle = ""

    /// While the hub is on screen it refreshes this often, so receipts opened on other phones show up.
    private static let refreshInterval: Duration = .seconds(20)

    private var allItems: [PaymentDue] {
        PaymentDueList.items(receipts: receipts.list.value ?? [], visits: queue.value ?? [])
    }

    /// A spinner until both lists have answered; then what loaded, with a retry row for a list that failed.
    private var loadState: PaymentDueLoadState {
        PaymentDueLoadState(
            receipts: (receipts.list.value != nil, receipts.list.failure),
            visits: (queue.value != nil, queue.failure)
        )
    }

    var body: some View {
        @Bindable var appState = appState
        NavigationStack(path: $appState.posPath) {
            List {
                ShiftStrip { appState.posPath.append(.shiftsHistory) }
                    .hubRow(top: 4, bottom: 4)
                let all = allItems
                let scope = pickedScope ?? PaymentDueList.defaultScope(all, employee: appState.employee)
                let visible = PaymentDueList.filtered(all, scope: scope, employeeId: appState.employee?.id)
                PaymentDueSection(
                    items: visible,
                    state: loadState,
                    scope: PaymentDueList.offersScope(to: appState.employee)
                        ? Binding(get: { scope }, set: { pickedScope = $0 })
                        : nil,
                    hidesAll: visible.isEmpty && !all.isEmpty,
                    cartReceiptId: cart.receiptId,
                    opening: opening,
                    retry: reload,
                    onOpen: open,
                    onDelete: { deletion = ReceiptDeletion($0) }
                )
            }
            .listStyle(.plain)
            .contentMargins(.horizontal, 16, for: .scrollContent)
            .contentMargins(.bottom, 24, for: .scrollContent)
            .auraBackground()
            .scrollEdgeEffectStyle(.soft, for: .top)
            .safeAreaBar(edge: .bottom) { newSaleButton }
            .refreshable {
                async let lists: Void = reload()
                async let shiftRefresh: Void = shift.refresh()
                _ = await (lists, shiftRefresh)
            }
            // Runs on every appearance and after each sale.
            .task(id: cart.salesCompleted) {
                await reload()
                if !shift.hasLoaded { await shift.refresh() }
                await pollWhileVisible()
            }
            .remoteErrorAlert(queue)
            .remoteErrorAlert(receipts.list)
            .receiptDeletionDialog($deletion, onDelete: delete)
            .navigationTitle("Касса")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink(value: POSRoute.salesHistory) {
                        Text("Продажи")
                    }
                    .accessibilityHint("История продаж и возвраты")
                }
            }
            .navigationDestination(for: POSRoute.self) { route in
                switch route {
                case .salesHistory: SalesHistoryView()
                case .shiftsHistory: ShiftsHistoryView()
                }
            }
        }
        .receiptFlow(isPresented: $showsReceipt) {
            Task { await reload() }
        }
        .errorAlert($errorMessage, title: errorTitle)
    }

    /// «Новая продажа»: a receipt without a visit; jewelry, goods and services are added in it.
    private var newSaleButton: some View {
        Button {
            run(.newReceipt) { try await receipts.openNew() }
        } label: {
            ZStack {
                Label("Новая продажа", systemImage: "plus")
                    .opacity(opening == .newReceipt ? 0 : 1)
                if opening == .newReceipt { ProgressView().tint(.white) }
            }
            .font(.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.glassProminent)
        .controlSize(.large)
        .disabled(opening != nil)
        .needsConnection()
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    // MARK: - Actions

    private func open(_ item: PaymentDue) {
        switch item {
        case .receipt(let receipt):
            run(.receipt(receipt.id)) { try await receipts.open(receipt) }
        case .visit(let appointment):
            // The visit's receipt with its services, client and prepayment (or the one another phone started).
            run(.visit(appointmentId: appointment.id)) { try await appState.startCheckout(for: appointment) }
        }
    }

    /// One receipt is opened at a time; on success it is shown over the hub.
    private func run(_ target: POSOpening, _ operation: @escaping () async throws -> Void) {
        guard opening == nil else { return }
        opening = target
        Task {
            defer { opening = nil }
            do {
                try await operation()
                showsReceipt = true
            } catch is CancellationError {
                return
            } catch {
                showError(error.userMessage, title: "Чек не открыт")
            }
        }
    }

    private func delete(_ deletion: ReceiptDeletion) {
        Task {
            do {
                try await appState.deleteReceipt(id: deletion.id, hasAppointment: deletion.hasAppointment)
                // The appointment is back among the unpaid ones.
                if deletion.hasAppointment { await loadQueue() }
            } catch {
                showError(error.userMessage, title: "Чек не удалён")
            }
        }
    }

    private func showError(_ message: String, title: String) {
        errorTitle = title
        errorMessage = message
    }

    // MARK: - Loading

    private func reload() async {
        async let receiptsLoad: Void = receipts.refresh()
        async let queueLoad: Void = loadQueue()
        _ = await (receiptsLoad, queueLoad)
    }

    private func loadQueue() async {
        await queue.load { try await api.appointmentsAwaitingPayment() }
    }

    /// Quiet refreshes until the hub disappears (another tab cancels the task).
    private func pollWhileVisible() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: Self.refreshInterval)
            guard !Task.isCancelled else { return }
            async let receiptsLoad: Void = receipts.refreshQuietly()
            async let queueLoad: Void = refreshQueueQuietly()
            _ = await (receiptsLoad, queueLoad)
        }
    }

    /// Polling failures are not shown: the next pull-to-refresh reports them.
    private func refreshQueueQuietly() async {
        guard let appointments = try? await api.appointmentsAwaitingPayment() else { return }
        queue.set(appointments)
    }
}

#if DEBUG
#Preview {
    POSView()
        .previewEnvironment()
}
#endif
