import Observation

/// Sales found over all time by a receipt number («17», «№17»), a client's name or phone, page by page.
@Observable
final class SalesSearchModel {
    static let pageSize = 50

    let remote = Remote<[Sale]>()
    /// What is typed in the search field.
    var text = ""
    private(set) var total = 0
    private(set) var isLoadingMore = false

    /// What is sent; `nil` — no search (the screen shows the chosen day).
    var query: String? { SaleSearch.query(text) }

    /// The first page of the current query; a cleared field drops the results.
    func load(api: APIClient) async {
        guard let query else {
            remote.reset()
            total = 0
            return
        }
        await remote.load {
            let page = try await api.sales(search: query, limit: Self.pageSize)
            // The query changed while this page was loading: its own load shows the right list.
            guard query == self.query else { throw CancellationError() }
            total = page.total ?? page.items.count
            return page.items
        }
    }

    /// The next page once the last row shows up, until all `total` sales are loaded.
    func loadMoreIfNeeded(after sale: Sale, api: APIClient) async {
        guard let query, let items = remote.value, sale.id == items.last?.id, items.count < total, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await api.sales(search: query, limit: Self.pageSize, offset: items.count)
            guard query == self.query else { return }
            let known = Set(items.map(\.id))
            remote.update { $0 + page.items.filter { !known.contains($0.id) } }
            total = page.items.isEmpty ? items.count : (page.total ?? total)
        } catch is CancellationError {
            return
        } catch {
            remote.transientError = error.userMessage
        }
    }
}

nonisolated enum SaleSearch {
    /// The server's limit of `search`.
    static let maxLength = 100

    /// The trimmed text, cut to the server's limit; `nil` when blank.
    static func query(_ text: String) -> String? {
        text.nonEmpty.map { String($0.prefix(maxLength)) }
    }
}

nonisolated enum SalesHistoryText {
    /// What the studio kept of these sales: their totals less what refunds returned.
    static func keptTotal(_ sales: [Sale]) -> Int {
        sales.reduce(0) { $0 + max(0, $1.total - $1.returnedAmount) }
    }
}
