import Observation
import SwiftUI

/// Pages of a client's bonus ledger (`GET /clients/:id/bonuses`), newest first.
@Observable
final class BonusHistoryModel {
    static let pageSize = 50

    let clientId: Int
    let remote = Remote<[BonusOperation]>()
    private(set) var balance: Int?
    private(set) var total = 0
    private(set) var isLoadingMore = false

    init(clientId: Int) {
        self.clientId = clientId
    }

    func load(api: APIClient) async {
        await remote.load {
            let page = try await api.clientBonuses(clientId: clientId, limit: Self.pageSize)
            balance = page.balance
            total = page.total ?? page.items.count
            return page.items
        }
    }

    func loadMoreIfNeeded(after operation: BonusOperation, api: APIClient) async {
        guard let items = remote.value, operation.id == items.last?.id, items.count < total, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await api.clientBonuses(clientId: clientId, limit: Self.pageSize, offset: items.count)
            let known = Set(items.map(\.id))
            remote.update { $0 + page.items.filter { !known.contains($0.id) } }
            balance = page.balance
            total = page.items.isEmpty ? items.count : (page.total ?? total)
        } catch is CancellationError {
            return
        } catch {
            remote.transientError = error.userMessage
        }
    }
}

/// «История бонусов»: the balance and every credit and debit with its sale, note and who made it.
struct ClientBonusHistoryView: View {
    @Environment(APIClient.self) private var api
    @Environment(\.permissions) private var permissions
    let client: ClientRef
    /// The balance changed here (an adjustment): the client card reloads.
    var onChange: () async -> Void = {}

    @State private var model: BonusHistoryModel
    @State private var showsAdjust = false

    init(client: ClientRef, onChange: @escaping () async -> Void = {}) {
        self.client = client
        self.onChange = onChange
        _model = State(initialValue: BonusHistoryModel(clientId: client.id))
    }

    var body: some View {
        List {
            if let balance = model.balance {
                Section {
                    LabeledContent {
                        Text(BonusText.count(balance)).font(.title2.weight(.bold)).monospacedDigit()
                    } label: {
                        Label("На счёте", systemImage: PaymentLine.bonusSymbol)
                    }
                }
            }
            Section {
                ForEach(model.remote.value ?? []) { operation in
                    BonusOperationRow(operation: operation)
                        .task { await model.loadMoreIfNeeded(after: operation, api: api) }
                }
                if model.isLoadingMore {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
        }
        .auraBackground()
        .overlay {
            RemoteStateOverlay(remote: model.remote, retry: { await model.load(api: api) }) {
                ContentUnavailableView(
                    "Операций пока нет",
                    systemImage: PaymentLine.bonusSymbol,
                    description: Text("Бонусы начисляются за покупки, когда в студии включена программа лояльности.")
                )
            }
        }
        .refreshable { await model.load(api: api) }
        .task { await model.load(api: api) }
        .remoteErrorAlert(model.remote)
        .navigationTitle("Бонусы · \(client.fullName)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if permissions.adjustsBonuses {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Начислить или списать", systemImage: "plusminus") { showsAdjust = true }
                }
            }
        }
        .sheet(isPresented: $showsAdjust) {
            BonusAdjustSheet(clientId: client.id, balance: model.balance ?? 0) {
                Task {
                    await model.load(api: api)
                    await onChange()
                }
            }
        }
    }
}

private struct BonusOperationRow: View {
    let operation: BonusOperation

    private var signed: Int { BonusLedger.signedAmount(operation) }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: BonusLedger.symbol(operation.type))
                .font(.subheadline)
                .foregroundStyle(signed < 0 ? Color.secondary : Color.accentColor)
                .frame(width: 30, height: 30)
                .background(.fill.tertiary, in: .circle)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(BonusLedger.title(operation.type)).font(.headline)
                    Spacer(minLength: 8)
                    Text(BonusLedger.signedText(signed))
                        .font(.headline)
                        .monospacedDigit()
                        .foregroundStyle(signed < 0 ? Color.primary : Color.green)
                }
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                    .monospacedDigit()
                if let note = operation.note.nonEmpty {
                    Text(note).font(.subheadline)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String {
        var parts = [DateText.dateTime(operation.createdAt)]
        if let number = operation.saleNumber { parts.append("чек №\(number)") }
        if let employee = operation.employee { parts.append(employee.name) }
        if signed > 0, let expiresAt = operation.expiresAt {
            let left = operation.remaining.map { "осталось \(Money.group(UInt(max(0, $0)))), " } ?? ""
            parts.append("\(left)сгорят \(DateText.dayMonth(expiresAt))")
        }
        return parts.joined(separator: " · ")
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        ClientBonusHistoryView(client: PreviewData.ivanRef)
    }
    .previewEnvironment()
}
#endif
