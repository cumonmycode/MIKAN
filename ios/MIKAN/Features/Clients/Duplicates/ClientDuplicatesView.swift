import Observation
import SwiftUI

/// The groups of likely duplicate cards (owner and admin). Shared by the clients list (its badge) and this screen.
@Observable
final class ClientDuplicatesModel {
    let remote = Remote<[DuplicateGroup]>()

    var count: Int { remote.value?.count ?? 0 }
    /// Whether the clients list shows its «Похожие карточки» row. Only the list updates it, so the row — and the screen
    /// it opened — stays while the last group is being resolved.
    private(set) var showsEntry = false

    func syncEntry() {
        showsEntry = count > 0
    }

    func load(api: APIClient) async {
        await remote.load { try await api.clientDuplicates() }
    }

    func remove(_ group: DuplicateGroup) {
        remote.remove(id: group.id)
    }
}

/// Clients → «Похожие карточки»: merge the cards of one person or mark them as different people.
struct ClientDuplicatesView: View {
    @Environment(APIClient.self) private var api
    let model: ClientDuplicatesModel
    /// A merge done here, for the clients list.
    var onMerged: (ClientMergeOutcome) -> Void = { _ in }

    @State private var merging: DuplicateGroup?
    @State private var dismissing: DuplicateGroup?
    @State private var isWorking = false
    @State private var errorMessage: String?

    var body: some View {
        List {
            if model.count > 0 {
                Section {
                    Text("Карточки, похожие на одного человека. Объедините их или отметьте, что это разные люди, — тогда они больше не появятся здесь.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .listRowBackground(Color.clear)
            }
            ForEach(model.remote.value ?? []) { group in
                DuplicateGroupSection(group: group, onMerge: { merging = group }, onDismiss: { dismissing = group })
            }
        }
        .listSectionSpacing(.compact)
        .auraBackground()
        .overlay {
            RemoteStateOverlay(remote: model.remote, retry: { await model.load(api: api) }) {
                ContentUnavailableView(
                    "Похожих карточек нет",
                    systemImage: "person.2.badge.gearshape",
                    description: Text("Здесь появятся карточки с одинаковыми именами, Telegram или Instagram.")
                )
            }
        }
        .disabled(isWorking)
        .refreshable { await model.load(api: api) }
        .task { await model.load(api: api) }
        .remoteErrorAlert(model.remote)
        .errorAlert($errorMessage)
        .navigationTitle("Похожие карточки")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $merging) { group in
            NavigationStack {
                ClientMergeView(
                    cards: group.clients,
                    onMerged: { finishMerge($0, in: group) },
                    onCancel: { merging = nil }
                )
            }
        }
        .confirmationDialog(
            "Это разные люди?",
            isPresented: Binding(get: { dismissing != nil }, set: { if !$0 { dismissing = nil } }),
            titleVisibility: .visible,
            presenting: dismissing
        ) { group in
            Button("Больше не предлагать") { dismiss(group) }
            Button("Отмена", role: .cancel) {}
        } message: { group in
            Text("Карточки \(group.clients.map(ClientMergePlan.cardLabel).joined(separator: ", ")) больше не будут предлагаться как похожие. Ничего не удалится.")
        }
    }

    private func finishMerge(_ outcome: ClientMergeOutcome, in group: DuplicateGroup) {
        merging = nil
        model.remove(group)
        errorMessage = outcome.failure
        onMerged(outcome)
        Task { await model.load(api: api) }
    }

    private func dismiss(_ group: DuplicateGroup) {
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                try await api.dismissDuplicates(clientIds: group.clientIds)
                model.remove(group)
                await model.load(api: api)
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        ClientDuplicatesView(model: ClientDuplicatesModel())
    }
    .previewEnvironment()
}
#endif
