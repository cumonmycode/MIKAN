import SwiftUI

/// Sales of a chosen day; the search finds sales of all time by a receipt number, a client's name or phone.
struct SalesHistoryView: View {
    @Environment(APIClient.self) private var api
    @State private var day = Calendar.app.startOfDay(for: .now)
    /// The day on screen: cleared only for another one, not when the screen reappears after a swipe back.
    @State private var shownDay: Date?
    @State private var sales = Remote<[Sale]>()
    @State private var search = SalesSearchModel()
    /// The query of the shown results, like `shownDay`: the same query is not reloaded when the screen reappears.
    @State private var shownQuery: String?

    private static let dayLimit = 200
    private static let searchDebounce: Duration = .milliseconds(350)

    private var isSearching: Bool { search.query != nil }

    var body: some View {
        List {
            if isSearching {
                searchResults
            } else {
                daySales
            }
        }
        .safeAreaBar(edge: .top) {
            if !isSearching {
                DayPickerBar(day: $day)
            }
        }
        // Always shown: an auto-hiding drawer above the pinned day bar made the list jump at the top.
        .searchable(
            text: $search.text,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Номер чека, имя или телефон"
        )
        .overlay {
            if isSearching {
                RemoteStateOverlay(remote: search.remote, retry: { await search.load(api: api) }) {
                    ContentUnavailableView.search(text: search.text.trimmed)
                }
            } else {
                RemoteStateOverlay(remote: sales, retry: load) {
                    ContentUnavailableView(
                        "Продаж нет",
                        systemImage: "receipt",
                        description: Text("В этот день продаж не было. Выберите другой день или найдите чек поиском.")
                    )
                }
            }
        }
        .refreshable {
            if isSearching { await search.load(api: api) } else { await load() }
        }
        .task(id: day) {
            if shownDay != day { sales.reset() }
            shownDay = day
            await load()
        }
        .task(id: search.query) {
            let query = search.query
            // Coming back from a sale keeps the loaded pages and the scroll; only another query starts over.
            guard query != shownQuery || search.remote.value == nil else { return }
            if query != nil {
                try? await Task.sleep(for: Self.searchDebounce)
                guard !Task.isCancelled else { return }
            }
            await search.load(api: api)
            // A load cut short (the screen left) runs again on return.
            if !Task.isCancelled { shownQuery = query }
        }
        .remoteErrorAlert(sales)
        .remoteErrorAlert(search.remote)
        .navigationTitle("История продаж")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private var daySales: some View {
        if let items = sales.value, !items.isEmpty {
            Section {
                ForEach(items) { sale in
                    NavigationLink {
                        SaleDetailView(sale: sale) { updated in sales.upsert(updated) }
                    } label: {
                        SaleRow(sale: sale)
                    }
                }
            } header: {
                HStack {
                    Text(Plural.count(items.count, one: "продажа", few: "продажи", many: "продаж"))
                    Spacer()
                    Text(Money.format(SalesHistoryText.keptTotal(items))).monospacedDigit()
                }
            }
        }
    }

    @ViewBuilder
    private var searchResults: some View {
        if let items = search.remote.value, !items.isEmpty {
            Section {
                ForEach(items) { sale in
                    NavigationLink {
                        SaleDetailView(sale: sale) { updated in
                            search.remote.upsert(updated)
                            // The chosen day keeps only its own sales.
                            sales.update { items in items.map { $0.id == updated.id ? updated : $0 } }
                        }
                    } label: {
                        SaleRow(sale: sale, showsDate: true)
                    }
                    .task { await search.loadMoreIfNeeded(after: sale, api: api) }
                }
                if search.isLoadingMore {
                    ProgressView().frame(maxWidth: .infinity)
                }
            } header: {
                Text("Найдено: \(search.total)").monospacedDigit()
            }
        }
    }

    private func load() async {
        let start = day
        guard let end = Calendar.app.date(byAdding: .day, value: 1, to: start) else { return }
        await sales.load { try await api.sales(from: start, to: end, limit: Self.dayLimit).items }
    }
}

/// ‹ day › selector with a compact date picker.
struct DayPickerBar: View {
    @Binding var day: Date

    var body: some View {
        HStack(spacing: 12) {
            Button("Предыдущий день", systemImage: "chevron.left") { shift(-1) }
                .labelStyle(.iconOnly)
            Spacer()
            DatePicker("День", selection: dayBinding, in: ...Date.now, displayedComponents: .date)
                .labelsHidden()
            Spacer()
            Button("Следующий день", systemImage: "chevron.right") { shift(1) }
                .labelStyle(.iconOnly)
                .disabled(Calendar.app.isDateInToday(day))
        }
        .buttonStyle(.glass)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private var dayBinding: Binding<Date> {
        Binding(get: { day }, set: { day = Calendar.app.startOfDay(for: $0) })
    }

    private func shift(_ offset: Int) {
        guard let next = Calendar.app.date(byAdding: .day, value: offset, to: day) else { return }
        withAnimation(.snappy) { day = next }
    }
}

struct SaleRow: View {
    let sale: Sale
    var showsDate = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text("№\(sale.number)").font(.headline).monospacedDigit()
                    Text(showsDate ? DateText.dateTime(sale.createdAt) : DateText.time(sale.createdAt))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                Text(sale.client?.fullName ?? "Без клиента")
                    .font(.subheadline)
                Text(sale.itemsSummary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                MoneyText(sale.total)
                    .font(.headline)
                    .strikethrough(sale.isRefunded)
                    .foregroundStyle(sale.isRefunded ? .secondary : .primary)
                if sale.isRefunded {
                    StatusBadge(text: "Возврат", color: .red)
                } else if sale.isPartlyRefunded {
                    StatusBadge(text: "Частичный возврат", color: .orange)
                    Text(Money.minus + Money.format(sale.returnedAmount))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                } else {
                    PaymentIcons(payments: sale.payments)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// One icon per payment method used (and the prepayment), read out as «Оплачено наличными и предоплатой».
private struct PaymentIcons: View {
    let payments: Payments

    var body: some View {
        HStack(spacing: 4) {
            ForEach(payments.paymentLines) { line in
                Image(systemName: line.symbol)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(PaymentText.methods(payments).map { "Оплачено \($0)" } ?? "")
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        SalesHistoryView()
    }
    .previewEnvironment()
}
#endif
