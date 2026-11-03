import SwiftUI

/// «Память маркетолога» (Titan `memory.tsx`): the staff's rules, conclusions from remarks and from analytics. The
/// marketer takes it into account in every plan and post; anything extra can be forgotten, your own added. Memory is
/// the selected profile's own: the studio's and the author's never mix.
struct SmmMemoryView: View {
    @Environment(APIClient.self) private var api
    @Environment(SmmProfileStore.self) private var store

    @State private var memory = Remote<[SmmMemory]>()
    @State private var addingKind: SmmMemoryKind?
    @State private var draft = ""
    @State private var pendingForget: SmmMemory?
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var successCount = 0

    /// Server limits of a memory line.
    private static let minLength = 3
    private static let maxLength = 400
    /// Display order of the kinds (Titan `KINDS`).
    private static let order: [SmmMemoryKind] = [.voice, .rule, .avoid, .fact, .insight, .unknown]
    /// Insights come from the reports only.
    private static let addable: [SmmMemoryKind] = [.voice, .rule, .avoid, .fact]

    private var brand: String { store.title(of: store.profile) }

    var body: some View {
        List {
            Section {
                Text("Маркетолог учитывает это в каждом плане и посте. Замечания вида «никогда так не пиши» он запоминает сам, выводы из отчётов — тоже.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
            }
            ForEach(Self.order, id: \.self) { kind in
                let items = (memory.value ?? []).filter { $0.kind == kind }
                if !items.isEmpty {
                    Section {
                        ForEach(items) { item in row(item) }
                    } header: {
                        Label(kind.memoryTitle(profile: store.profile, brand: brand), systemImage: kind.memorySymbol)
                    }
                }
            }
        }
        .auraBackground()
        .overlay {
            RemoteStateOverlay(remote: memory, retry: load) {
                ContentUnavailableView {
                    Label("Пока пусто", systemImage: "brain.head.profile")
                } description: {
                    Text("Оставляйте замечания к постам — общие правила маркетолог запомнит сам. Или добавьте их кнопкой «+».")
                }
            }
        }
        .refreshable { await load() }
        .task(id: store.profile) {
            memory.reset()
            await load()
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { addMenu }
        }
        .alert(addingKind?.memoryTitle(profile: store.profile, brand: brand) ?? "", isPresented: addingBinding, presenting: addingKind) { kind in
            TextField("Одна мысль", text: $draft)
            Button("Запомнить") { add(kind) }
            Button("Отмена", role: .cancel) {}
        } message: { _ in
            Text("Одна мысль — коротко. Например: «Не пишем слово „уникальный“» или «Гостевые сеансы анонсируем за неделю».")
        }
        .confirmationDialog("Забыть?", isPresented: forgetBinding, titleVisibility: .visible, presenting: pendingForget) { item in
            Button("Забыть", role: .destructive) { forget(item) }
            Button("Отмена", role: .cancel) {}
        } message: { item in
            Text(item.text)
        }
        .remoteErrorAlert(memory)
        .errorAlert($errorMessage, title: "Не получилось")
        .sensoryFeedback(.success, trigger: successCount)
        .navigationTitle("Память маркетолога")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ item: SmmMemory) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.text)
                .textSelection(.enabled)
            if let source = item.source.memoryTitle {
                Text(source)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .swipeActions(edge: .trailing) {
            Button("Забыть", systemImage: "trash") { pendingForget = item }
                .tint(.red)
        }
        .contextMenu {
            Button("Забыть", systemImage: "trash", role: .destructive) { pendingForget = item }
        }
    }

    private var addMenu: some View {
        Menu {
            Section("Что запомнить?") {
                ForEach(Self.addable, id: \.self) { kind in
                    Button(kind.memoryTitle(profile: store.profile, brand: brand), systemImage: kind.memorySymbol) {
                        draft = ""
                        addingKind = kind
                    }
                }
            }
        } label: {
            if isSaving {
                ProgressView()
            } else {
                Label("Добавить", systemImage: "plus")
            }
        }
        .disabled(isSaving || memory.value == nil)
    }

    private var addingBinding: Binding<Bool> {
        Binding(get: { addingKind != nil }, set: { if !$0 { addingKind = nil } })
    }

    private var forgetBinding: Binding<Bool> {
        Binding(get: { pendingForget != nil }, set: { if !$0 { pendingForget = nil } })
    }

    private func load() async {
        let profile = store.profile
        await memory.load { try await api.smmMemory(profile) }
    }

    private func add(_ kind: SmmMemoryKind) {
        let text = draft.trimmed
        guard text.count >= Self.minLength else {
            errorMessage = "Слишком коротко — напишите мысль хотя бы в несколько слов."
            return
        }
        guard text.count <= Self.maxLength else {
            errorMessage = "Слишком длинно — не больше \(Self.maxLength) символов."
            return
        }
        save { profile in try await api.addSmmMemory(profile, kind: kind, text: text) }
    }

    private func forget(_ item: SmmMemory) {
        save { profile in try await api.deleteSmmMemory(profile, id: item.id) }
    }

    /// Both writes answer with the whole memory of the profile.
    private func save(_ write: @escaping @MainActor (SmmProfile) async throws -> [SmmMemory]) {
        let profile = store.profile
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                let fresh = try await write(profile)
                guard profile == store.profile else { return }
                withAnimation { memory.set(fresh) }
                successCount += 1
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

private extension SmmMemoryKind {
    /// Section titles; facts are about the studio, or about the author by her brand name.
    func memoryTitle(profile: SmmProfile, brand: String) -> String {
        switch self {
        case .voice: "Голос и стиль"
        case .rule: "Правила"
        case .avoid: "Нельзя"
        case .fact: profile == .studio ? "Факты о студии" : "Факты · \(brand)"
        case .insight: "Выводы из аналитики"
        case .unknown: "Другое"
        }
    }

    var memorySymbol: String {
        switch self {
        case .voice: "waveform"
        case .rule: "checklist"
        case .avoid: "nosign"
        case .fact: "info.circle"
        case .insight: "chart.line.uptrend.xyaxis"
        case .unknown: "brain"
        }
    }
}

private extension SmmMemorySource {
    var memoryTitle: String? {
        switch self {
        case .staff: "добавлено вручную"
        case .remark: "из замечания"
        case .analytics: "из отчёта"
        case .unknown: nil
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        SmmMemoryView()
            .environment(SmmProfileStore())
    }
    .previewEnvironment()
}
#endif
