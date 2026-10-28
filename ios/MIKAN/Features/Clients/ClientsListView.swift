import Observation
import SwiftUI

/// Paginated, searchable client list.
@Observable
final class ClientsListModel {
    static let pageSize = 50

    let remote = Remote<[Client]>()
    private(set) var total = 0
    private(set) var isLoadingMore = false
    var search = ""
    var showsArchived = false

    var queryKey: String { "\(search)|\(showsArchived)" }

    func load(api: APIClient) async {
        let search = search
        let archived = showsArchived
        // The saved list shows at once while the server is asked.
        if remote.value == nil, search.isEmpty, !archived, let saved = await api.savedClients() {
            remote.set(saved.items)
            total = saved.total
        }
        await remote.load {
            let page = try await api.clients(search: search, archived: archived, limit: Self.pageSize)
            total = page.total ?? page.items.count
            return page.items
        }
    }

    func loadMoreIfNeeded(after client: Client, api: APIClient) async {
        guard let items = remote.value, client.id == items.last?.id, items.count < total, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await api.clients(search: search, archived: showsArchived, limit: Self.pageSize, offset: items.count)
            let known = Set(items.map(\.id))
            remote.update { $0 + page.items.filter { !known.contains($0.id) } }
            total = page.total ?? total
        } catch is CancellationError {
            return
        } catch {
            remote.transientError = error.userMessage
        }
    }

    func upsert(_ client: Client) {
        remote.upsert(client)
    }

    /// Merged cards leave the list; the kept one is refreshed where it is shown.
    func apply(_ outcome: ClientMergeOutcome) {
        let removed = Set(outcome.removedIds)
        remote.update { items in
            items.filter { !removed.contains($0.id) }.map { $0.id == outcome.kept.id ? outcome.kept : $0 }
        }
        total = max(0, total - removed.count)
    }
}

struct ClientsListView: View {
    @Environment(APIClient.self) private var api
    @Environment(\.permissions) private var permissions
    @State private var model = ClientsListModel()
    @State private var duplicates = ClientDuplicatesModel()
    @State private var showsEditor = false
    @State private var createdClient: Client?

    private static let searchDebounce: Duration = .milliseconds(300)

    var body: some View {
        NavigationStack {
            List {
                if showsDuplicates {
                    Section {
                        NavigationLink {
                            ClientDuplicatesView(model: duplicates, onMerged: applyMerge)
                        } label: {
                            Label("Похожие карточки", systemImage: "person.2.badge.gearshape")
                        }
                        .badge(duplicates.count)
                    }
                }
                ForEach(model.remote.value ?? []) { client in
                    NavigationLink {
                        detail(client)
                    } label: {
                        ClientRow(client: client)
                    }
                    .task { await model.loadMoreIfNeeded(after: client, api: api) }
                }
                if model.isLoadingMore {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .auraBackground()
            .scrollEdgeEffectStyle(.soft, for: .top)
            .searchable(text: $model.search, prompt: "Имя, фамилия, телефон, ник")
            .overlay {
                RemoteStateOverlay(remote: model.remote, retry: { await model.load(api: api) }) {
                    emptyState
                }
            }
            .refreshable {
                await model.load(api: api)
                await loadDuplicates()
            }
            .task { await loadDuplicates() }
            .onAppear { duplicates.syncEntry() }
            .task(id: model.queryKey) {
                if !model.search.isEmpty {
                    try? await Task.sleep(for: Self.searchDebounce)
                    guard !Task.isCancelled else { return }
                }
                await model.load(api: api)
            }
            .remoteErrorAlert(model.remote)
            .onReconnect { await model.load(api: api) }
            .navigationTitle(model.showsArchived ? "Архив клиентов" : "Клиенты")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Toggle(isOn: $model.showsArchived) {
                        Label("Архив", systemImage: "archivebox")
                    }
                    .toggleStyle(.button)
                    .accessibilityLabel(model.showsArchived ? "Показать активных клиентов" : "Показать архив")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Новый клиент", systemImage: "plus") { showsEditor = true }
                        .needsConnection()
                }
            }
            .sheet(isPresented: $showsEditor) {
                ClientEditorView(client: nil) { saved in
                    model.upsert(saved)
                    createdClient = saved
                }
            }
            .navigationDestination(item: $createdClient) { client in
                detail(client)
            }
        }
    }

    /// «Похожие карточки» for owner and admin, above the active clients while not searching.
    private var showsDuplicates: Bool {
        permissions.mergesClients && !model.showsArchived && model.search.trimmed.isEmpty && duplicates.showsEntry
    }

    private func detail(_ client: Client) -> some View {
        ClientDetailView(clientId: client.id, initial: client, onChange: { model.upsert($0) }, onMerged: applyMerge)
    }

    private func loadDuplicates() async {
        guard permissions.mergesClients else { return }
        await duplicates.load(api: api)
        duplicates.syncEntry()
    }

    private func applyMerge(_ outcome: ClientMergeOutcome) {
        model.apply(outcome)
        Task { await loadDuplicates() }
    }

    @ViewBuilder
    private var emptyState: some View {
        if !model.search.trimmed.isEmpty {
            ContentUnavailableView.search(text: model.search)
        } else if model.showsArchived {
            ContentUnavailableView(
                "Архив пуст",
                systemImage: "archivebox",
                description: Text("Здесь появятся клиенты, которых вы отправили в архив.")
            )
        } else {
            ContentUnavailableView(
                "Клиентов пока нет",
                systemImage: "person.2",
                description: Text("Нажмите «+», чтобы добавить первого клиента.")
            )
        }
    }
}

#if DEBUG
#Preview {
    ClientsListView()
        .previewEnvironment()
}
#endif
