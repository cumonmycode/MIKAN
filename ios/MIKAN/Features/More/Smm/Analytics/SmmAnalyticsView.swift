import SwiftUI

/// «Аналитика» (Titan `analytics.tsx`): by the platforms' APIs, no screenshots. Per account — followers and their
/// growth, reach and engagement for 7 or 30 days, the daily chart, which formats, weekdays and hours work, Instagram's
/// audience and the best publications. Below — the marketer's forecast against the fact and the reports with
/// conclusions. Numbers refresh by themselves (fresh posts hourly); «Обновить» collects them now. Works in the
/// selected SMM profile.
struct SmmAnalyticsView: View {
    @Environment(APIClient.self) private var api
    @Environment(SmmProfileStore.self) private var store
    @Environment(ReferenceStore.self) private var reference

    @State private var analytics = Remote<SmmAnalytics>()
    @State private var window: SmmAnalyticsWindow = .week
    @State private var job: Job?
    @State private var failureTitle = "Не получилось"
    @State private var errorMessage: String?
    @State private var openedReport: SmmReport?
    @State private var isPickingPeriod = false
    @State private var successCount = 0

    /// Awaited work with an estimated progress scale.
    private struct Job: Equatable {
        enum Kind: Equatable {
            case collect, report
        }

        let kind: Kind
        let progress: SmmProgress
    }

    /// The forecast section shows the latest published posts.
    private static let recentPosts = 8
    private static let collectEta = 25.0
    private static let reportEta = 30.0

    private var timeZone: TimeZone { reference.workday.timeZone }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let value = analytics.value {
                    content(value)
                }
            }
            .padding(16)
            .animation(.smooth, value: job)
        }
        .background { AuraBackground() }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .safeAreaBar(edge: .top) { windowPicker }
        .overlay {
            if analytics.value == nil {
                RemoteStateOverlay(remote: analytics, retry: load)
            }
        }
        .refreshable { await load() }
        .task(id: store.profile) {
            analytics.reset()
            await load()
        }
        .remoteErrorAlert(analytics)
        .errorAlert($errorMessage, title: failureTitle)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { collectButton }
        }
        .sheet(isPresented: $isPickingPeriod) {
            SmmReportPeriodSheet { from, to in makeReport(from: from, to: to) }
        }
        .navigationDestination(item: $openedReport) { report in
            SmmReportView(id: report.id, initial: report)
                .environment(store)
        }
        .sensoryFeedback(.success, trigger: successCount)
        .navigationTitle("Аналитика")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Content

    @ViewBuilder
    private func content(_ value: SmmAnalytics) -> some View {
        if let job {
            SmmProgressBanner(progress: job.progress)
        }
        accounts(value)
        SmmGroupTitle("Прогноз и факт")
        SmmAccuracyCard(accuracy: value.accuracy)
        ForEach(Array(value.posts.suffix(Self.recentPosts).reversed())) { post in
            NavigationLink(value: SmmRoute.post(id: post.id)) {
                SmmPostRow(post: post, timeZone: timeZone, showsDay: true)
                    .cardStyle(padding: 12)
                    .contentShape(.rect(cornerRadius: Theme.cardRadius))
            }
            .buttonStyle(.plain)
        }
        SmmGroupTitle("Отчёты маркетолога")
        ForEach(value.reports) { report in
            NavigationLink(value: SmmRoute.report(id: report.id)) {
                SmmReportRow(report: report)
            }
            .buttonStyle(.plain)
        }
        reportMenu(isFirst: value.reports.isEmpty)
        Text(footer(value.spend))
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.bottom, 16)
    }

    @ViewBuilder
    private func accounts(_ value: SmmAnalytics) -> some View {
        let active = value.accounts.filter(\.isActive)
        if active.isEmpty {
            notConnected(hasAccounts: !value.accounts.isEmpty)
        }
        ForEach(active) { account in
            SmmAccountCard(
                account: account,
                window: window,
                history: value.history.filter { $0.accountId == account.id },
                insight: value.platforms.first { $0.accountId == account.id },
                timeZone: timeZone
            )
        }
    }

    private func notConnected(hasAccounts: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(hasAccounts ? "Площадки выключены" : "Площадки не подключены", systemImage: "antenna.radiowaves.left.and.right.slash")
                .font(.headline)
            Text(hasAccounts
                ? "Включите канал Telegram или Instagram в «Площадках» — маркетолог снова начнёт собирать цифры."
                : "Добавьте канал Telegram и Instagram в «Площадках» — маркетолог начнёт собирать цифры сам.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            NavigationLink(value: SmmRoute.accounts) {
                Label("Открыть площадки", systemImage: "antenna.radiowaves.left.and.right")
            }
            .buttonStyle(.glass)
        }
        .cardStyle()
    }

    @ViewBuilder
    private func reportMenu(isFirst: Bool) -> some View {
        let menu = Menu {
            Button("За неделю", systemImage: "calendar") { makeReport(from: nil, to: nil) }
            Button("За прошлый месяц", systemImage: "calendar.badge.clock") { makeLastMonthReport() }
            Button("Выбрать период…", systemImage: "calendar.badge.plus") { isPickingPeriod = true }
        } label: {
            Label(job?.kind == .report ? "Маркетолог разбирает цифры…" : "Сделать отчёт", systemImage: "doc.text.magnifyingglass")
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
        }
        .controlSize(.large)
        .disabled(job != nil)
        if isFirst {
            menu.buttonStyle(.glassProminent)
        } else {
            menu.buttonStyle(.glass)
        }
    }

    private var windowPicker: some View {
        Picker("Период", selection: $window) {
            ForEach(SmmAnalyticsWindow.allCases) { window in
                Text(window.title).tag(window)
            }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var collectButton: some View {
        if job?.kind == .collect {
            ProgressView()
        } else {
            Button("Обновить", systemImage: "arrow.clockwise", action: collect)
                .disabled(job != nil || analytics.value == nil)
        }
    }

    private func footer(_ spend: SmmSpend) -> String {
        let budget = spend.budget > 0 ? " из \(SmmText.count(spend.budget)) ₽" : ""
        return "Цифры — по API площадок: свежие посты каждый час, остальное раз в день. "
            + "Отчёт маркетолог делает сам по понедельникам. "
            + "Нейросети в этом месяце: \(SmmText.count(spend.month)) ₽\(budget)."
    }

    // MARK: - Loading and actions

    private func load() async {
        let profile = store.profile
        await analytics.load { try await api.smmAnalytics(profile) }
    }

    private func collect() {
        run(.collect, label: "Маркетолог собирает цифры площадок", eta: Self.collectEta, failure: "Цифры не обновились") { profile in
            let fresh = try await api.collectSmmStats(profile)
            withAnimation(.smooth) { analytics.set(fresh) }
        }
    }

    /// The previous calendar month in the studio time zone.
    private func makeLastMonthReport() {
        let month = SmmText.shiftMonth(SmmText.monthKey(of: .now, in: timeZone), by: -1)
        makeReport(from: SmmPlanMath.dayKey(month, 1), to: SmmPlanMath.dayKey(month, SmmPlanMath.dayCount(month)))
    }

    /// Without a period — the last seven days (the server's default, as Titan's weekly report).
    private func makeReport(from: String?, to: String?) {
        run(.report, label: "Маркетолог разбирает цифры и пишет отчёт", eta: Self.reportEta, failure: "Отчёт не получился") { profile in
            let created = try await api.generateSmmReport(profile, from: from, to: to)
            withAnimation(.smooth) {
                analytics.update { value in
                    SmmAnalytics(
                        accounts: value.accounts, history: value.history, platforms: value.platforms,
                        posts: value.posts, accuracy: value.accuracy,
                        reports: [created] + value.reports.filter { $0.id != created.id }, spend: value.spend
                    )
                }
            }
            openedReport = created
        }
    }

    private func run(
        _ kind: Job.Kind, label: String, eta: Double, failure: String,
        _ work: @escaping @MainActor (SmmProfile) async throws -> Void
    ) {
        guard job == nil else { return }
        let profile = store.profile
        job = Job(kind: kind, progress: .estimate(label, eta: eta))
        Task {
            defer { job = nil }
            do {
                try await work(profile)
                successCount += 1
            } catch is CancellationError {
                return
            } catch {
                failureTitle = failure
                errorMessage = error.userMessage
            }
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        SmmAnalyticsView()
            .environment(SmmProfileStore())
    }
    .previewEnvironment()
}
#endif
