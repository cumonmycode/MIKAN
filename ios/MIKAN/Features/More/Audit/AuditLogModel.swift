import Observation

/// Pages of an audit log: the studio's (filtered), or one card's history.
@Observable
final class AuditLogModel {
    static let pageSize = 50

    let scope: AuditScope
    let remote = Remote<[AuditEntry]>()
    var filter = AuditFilter()
    private(set) var total = 0
    private(set) var isLoadingMore = false
    /// The filter the shown entries belong to.
    private var loadedFilter: AuditFilter?

    init(scope: AuditScope) {
        self.scope = scope
    }

    var days: [AuditDay] { AuditDay.grouping(remote.value ?? []) }

    /// Coming back to the screen keeps the loaded pages; another filter starts over.
    func loadIfNeeded(api: APIClient) async {
        if remote.value != nil, loadedFilter == filter { return }
        remote.reset()
        await load(api: api)
    }

    /// The first page (pull to refresh, retry, a new filter).
    func load(api: APIClient) async {
        let filter = filter
        let query = scope.query(filter, offset: 0, limit: Self.pageSize)
        await remote.load {
            let page = try await api.auditLog(query)
            // The filter changed while this page was loading: its own load shows the right entries.
            guard filter == self.filter else { throw CancellationError() }
            total = page.total ?? page.items.count
            loadedFilter = filter
            return page.items
        }
    }

    /// The next page once the last row shows up, until all `total` entries are loaded.
    func loadMoreIfNeeded(after entry: AuditEntry, api: APIClient) async {
        guard let items = remote.value, entry.id == items.last?.id, items.count < total, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        let filter = filter
        do {
            let page = try await api.auditLog(scope.query(filter, offset: items.count, limit: Self.pageSize))
            guard filter == self.filter else { return }
            remote.update { current in
                let known = Set(current.map(\.id))
                return current + page.items.filter { !known.contains($0.id) }
            }
            // An empty page means the log shrank since the first load (old rows are pruned): stop asking for more.
            total = page.items.isEmpty ? items.count : (page.total ?? total)
        } catch is CancellationError {
            return
        } catch {
            remote.transientError = error.userMessage
        }
    }
}
