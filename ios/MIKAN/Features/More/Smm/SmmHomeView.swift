import SwiftUI

/// «СММ-маркетолог» — the headquarters of the selected profile's socials (Titan `smm/index.tsx`): on top what needs a
/// person (approve, send a link, failed), then the two-week feed by day, the month's plan, the platforms with their
/// numbers, the last report, spend and readiness, and the tools. The marketer does the work; here — decisions and
/// remarks. The switcher on top picks the profile (the studio or the author) every SMM screen works in.
struct SmmHomeView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppState.self) private var appState
    @Environment(ReferenceStore.self) private var reference
    @State private var store = SmmProfileStore()
    @State private var overview = Remote<SmmOverview>()

    /// While the marketer writes, draws or plans, the home refreshes this often (Titan: twice the post poll).
    private static let pollInterval: Duration = .seconds(6)

    private struct LoadKey: Hashable {
        let profile: SmmProfile
        let isEnabled: Bool
    }

    private var timeZone: TimeZone { reference.workday.timeZone }

    var body: some View {
        List {
            if store.isEnabled, let data = overview.value {
                SmmHeroSection(overview: data)
                SmmAttentionSection(posts: data.upcoming, timeZone: timeZone)
                SmmReadinessSection(ready: data.ready)
                SmmFeedSections(posts: data.upcoming, timeZone: timeZone, month: data.month)
                SmmPlanSection(overview: data, profile: store.profile)
                if let report = data.lastReport {
                    SmmLastReportSection(report: report)
                }
                SmmToolsSections(overview: data, profile: store.profile)
                SmmSpendSection(overview: data)
            }
        }
        .overlay { stateOverlay }
        .safeAreaBar(edge: .top) { profilePicker }
        .auraBackground()
        .navigationTitle("СММ-маркетолог")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if store.isEnabled {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink(value: SmmRoute.newPost()) {
                        Label("Новая публикация", systemImage: "plus")
                    }
                }
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
            }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: SmmRoute.settings) {
                    Label("Настройки профиля", systemImage: "gearshape")
                }
            }
        }
        .navigationDestination(for: SmmRoute.self) { route in
            SmmRouteDestination(route: route)
                .environment(store)
        }
        .environment(store)
        .task(id: LoadKey(profile: store.profile, isEnabled: store.isEnabled)) { await run() }
        .onChange(of: store.profile) { overview.reset() }
        .refreshable { await reload() }
        .remoteErrorAlert(overview)
    }

    private var profilePicker: some View {
        Picker("Профиль", selection: $store.profile) {
            ForEach(SmmProfile.allCases) { profile in
                Text(store.title(of: profile)).tag(profile)
            }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var stateOverlay: some View {
        if store.isEnabled {
            RemoteStateOverlay(remote: overview) { await loadOverview(store.profile) }
        } else {
            ContentUnavailableView {
                Label("Профиль «\(store.title(of: store.profile))» выключен", systemImage: "pause.circle")
            } description: {
                Text(disabledText)
            } actions: {
                NavigationLink(value: SmmRoute.settings) {
                    Text("Открыть настройки")
                }
                .buttonStyle(.glassProminent)
                NavigationLink(value: SmmRoute.knowledge) {
                    Text("Заполнить базу знаний")
                }
                .buttonStyle(.glass)
            }
        }
    }

    private var disabledText: String {
        switch store.profile {
        case .studio:
            "Маркетолог не готовит и не публикует посты студии, пока профиль выключен. Включите его в настройках и подключите площадки."
        case .author:
            "Личные соцсети \(store.title(of: .author)) ведутся отдельно от студии: свои площадки, настройки и база знаний. "
                + "Включите профиль в настройках — маркетолог начнёт готовить посты."
        }
    }

    // MARK: Data

    /// On appear, on return from a pushed screen and when the profile changes or gets enabled.
    private func run() async {
        let profile = store.profile
        if store.profiles.isEmpty {
            await store.load(using: api)
        }
        guard store.isEnabled, !Task.isCancelled else { return }
        async let workday: Void = loadWorkday()
        async let badges: Void = appState.refreshBadges()
        await loadOverview(profile)
        _ = await (workday, badges)
        await pollWhileBusy(profile)
    }

    private func reload() async {
        async let profiles: Void = store.load(using: api)
        async let badges: Void = appState.refreshBadges()
        if store.isEnabled {
            await loadOverview(store.profile)
        }
        _ = await (profiles, badges)
    }

    private func loadOverview(_ profile: SmmProfile) async {
        await overview.load { try await api.smmOverview(profile) }
    }

    private func loadWorkday() async {
        try? await reference.ensureWorkday()
    }

    /// Titan polls the overview while a post or the plan is being worked on.
    private func pollWhileBusy(_ profile: SmmProfile) async {
        while !Task.isCancelled, let data = overview.value, Self.isBusy(data) {
            try? await Task.sleep(for: Self.pollInterval)
            guard !Task.isCancelled, profile == store.profile else { return }
            if let fresh = try? await api.smmOverview(profile) {
                overview.set(fresh)
            }
        }
    }

    private static func isBusy(_ data: SmmOverview) -> Bool {
        data.upcoming.contains { $0.busy != nil } || data.plan?.busy != nil || data.nextPlan?.busy != nil
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        SmmHomeView()
    }
    .previewEnvironment()
}
#endif
