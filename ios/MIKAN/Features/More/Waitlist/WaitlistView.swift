import SwiftUI

/// «Лист ожидания»: clients waiting for taken time to free up, grouped by status. Every staff role may add an entry
/// for a client, cancel an open one and open the appointment of a booked one.
struct WaitlistView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppState.self) private var appState

    @State private var entries = Remote<[WaitlistEntry]>()
    @State private var showsEditor = false
    @State private var pendingCancel: WaitlistEntry?
    @State private var cancellingId: Int?
    @State private var errorMessage: String?
    @State private var successCount = 0

    private var sections: [WaitlistSection] {
        WaitlistGrouping.sections(entries.value ?? [])
    }

    var body: some View {
        List {
            ForEach(sections) { section in
                Section {
                    ForEach(section.entries) { entry in
                        row(entry)
                    }
                } header: {
                    Text("\(WaitlistGrouping.title(section.status)) · \(section.entries.count)")
                }
            }
        }
        .auraBackground()
        .overlay {
            RemoteStateOverlay(remote: entries, retry: load) {
                ContentUnavailableView {
                    Label("Лист ожидания пуст", systemImage: "hourglass")
                } description: {
                    Text("Сюда попадают клиенты, которым не нашлось свободного времени: бот сообщит им, как только оно освободится. Клиенты встают в лист сами на сайте и в боте, а вы можете добавить их здесь.")
                } actions: {
                    Button("Добавить клиента") { showsEditor = true }
                        .buttonStyle(.glassProminent)
                }
            }
        }
        .refreshable { await load() }
        // Also when the badge poll sees a new entry or one closed elsewhere.
        .task(id: appState.badges.waitlist) { await load() }
        .remoteErrorAlert(entries)
        .errorAlert($errorMessage)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Добавить", systemImage: "plus") { showsEditor = true }
            }
        }
        .sheet(isPresented: $showsEditor) {
            WaitlistEditorView { created in
                apply(created)
                successCount += 1
            }
        }
        .confirmationDialog(
            "Отменить заявку?",
            isPresented: cancelBinding,
            titleVisibility: .visible,
            presenting: pendingCancel
        ) { entry in
            Button("Отменить заявку", role: .destructive) { cancel(entry) }
            Button("Не отменять", role: .cancel) {}
        } message: { entry in
            Text("\(entry.client.fullName) больше не получит сообщение о свободном времени: \(WaitlistText.services(entry.items)), \(WaitlistText.range(from: entry.dateFrom, to: entry.dateTo)).")
        }
        .sensoryFeedback(.success, trigger: successCount)
        .navigationTitle("Лист ожидания")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func row(_ entry: WaitlistEntry) -> some View {
        Group {
            if entry.status == .booked, let appointmentId = entry.appointmentId {
                NavigationLink {
                    AppointmentLoaderView(appointmentId: appointmentId)
                } label: {
                    WaitlistRow(entry: entry, isCancelling: false)
                }
                .accessibilityHint("Открывает запись клиента")
            } else {
                WaitlistRow(entry: entry, isCancelling: cancellingId == entry.id)
            }
        }
        .swipeActions(edge: .trailing) {
            if entry.status.isOpen {
                Button("Отменить", systemImage: "xmark") { pendingCancel = entry }
                    .tint(.red)
            }
        }
        .contextMenu {
            if entry.status.isOpen {
                Button("Отменить заявку", systemImage: "xmark", role: .destructive) { pendingCancel = entry }
            }
        }
        .disabled(cancellingId == entry.id)
    }

    private var cancelBinding: Binding<Bool> {
        Binding(get: { pendingCancel != nil }, set: { if !$0 { pendingCancel = nil } })
    }

    private func load() async {
        await entries.load { try await api.waitlist() }
    }

    private func cancel(_ entry: WaitlistEntry) {
        cancellingId = entry.id
        Task {
            defer { cancellingId = nil }
            do {
                apply(try await api.cancelWaitlistEntry(id: entry.id))
                successCount += 1
            } catch {
                errorMessage = error.userMessage
                // Often booked or expired meanwhile (`409`): show the list as it is now.
                await load()
            }
        }
    }

    private func apply(_ updated: WaitlistEntry) {
        if entries.value == nil {
            entries.set([updated])
        } else {
            entries.update { WaitlistGrouping.applying(updated, to: $0) }
        }
        Task { await appState.refreshBadges() }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        WaitlistView()
    }
    .previewEnvironment()
}
#endif
