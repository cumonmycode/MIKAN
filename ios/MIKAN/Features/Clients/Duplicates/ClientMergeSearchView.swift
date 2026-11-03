import SwiftUI

/// «Объединить с…» on a client card: find the other card of the same person, then choose which one stays.
struct ClientMergeSearchView: View {
    @Environment(APIClient.self) private var api
    let client: Client
    let onMerged: (ClientMergeOutcome) -> Void

    @State private var search: String
    @State private var results = Remote<[Client]>()
    @State private var picked: Client?

    private static let searchDebounce: Duration = .milliseconds(300)

    init(client: Client, onMerged: @escaping (ClientMergeOutcome) -> Void) {
        self.client = client
        self.onMerged = onMerged
        // Namesakes first: the other card of the same person usually shares the first name.
        _search = State(initialValue: PersonName.split(client.fullName).first)
    }

    private var candidates: [Client] { (results.value ?? []).filter { $0.id != client.id } }

    var body: some View {
        List {
            if !candidates.isEmpty {
                Section {
                    ForEach(candidates) { other in
                        Button { picked = other } label: { ClientRow(client: other) }
                    }
                } footer: {
                    Text("Выберите карточку этого же человека — на следующем шаге решите, какую оставить.")
                }
            }
        }
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Имя, фамилия, телефон, ник")
        .overlay {
            RemoteStateOverlay(remote: results, isEmpty: { $0.allSatisfy { $0.id == client.id } }, retry: load) {
                ContentUnavailableView(
                    "Других карточек не найдено",
                    systemImage: "magnifyingglass",
                    description: Text("Поищите по телефону, фамилии или нику.")
                )
            }
        }
        .task(id: search) {
            try? await Task.sleep(for: Self.searchDebounce)
            guard !Task.isCancelled else { return }
            await load()
        }
        .navigationTitle("Объединить с…")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $picked) { other in
            ClientMergeView(cards: [client, other], onMerged: onMerged)
        }
    }

    private func load() async {
        let query = search
        await results.load { try await api.clients(search: query, limit: 50).items }
    }
}
