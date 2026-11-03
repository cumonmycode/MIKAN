import os
import SwiftUI

/// «План месяца» (Titan `plan.tsx`): the strategy, goals, rubrics and occasions of the month and its publications by
/// weeks. Once the plan is approved the marketer prepares the posts ahead. A remark to the plan (move, add, remove,
/// more reels) the marketer applies by itself and answers what it changed. «Порядок» swaps neighbouring publications
/// (their times). Posts that will not go out stay greyed. Works in the selected SMM profile.
struct SmmPlanView: View {
    @Environment(APIClient.self) private var api
    @Environment(SmmProfileStore.self) private var store
    @Environment(ReferenceStore.self) private var reference

    @State private var month: String
    @State private var payload = Remote<SmmPlanPayload>()
    /// Next month's plan when this is the current month: the marketer drafts it on the 25th.
    @State private var nextPlan: SmmPlan?
    @State private var action: PlanAction?
    @State private var isOrdering = false
    @State private var swappingId: String?
    @State private var isAskingWishes = false
    @State private var wishes = ""
    @State private var remark = ""
    @State private var errorMessage: String?
    @State private var successCount = 0
    @State private var swapCount = 0

    private let logger = Logger(subsystem: "com.mikanstudio.crm", category: "smm")

    private enum PlanAction: Equatable {
        case generate, approve, remark
    }

    /// While the marketer works on the plan the screen asks every few seconds; slower while only posts are being
    /// written.
    private static let busyPoll = 3
    private static let postsPoll = 6

    init(month: String) {
        _month = State(initialValue: month)
    }

    private var timeZone: TimeZone { reference.workday.timeZone }
    private var profile: SmmProfile { store.profile }
    private var currentMonth: String { SmmText.monthKey(of: .now, in: timeZone) }
    private var today: String { SmmText.dayKey(of: .now, in: timeZone) }
    private var isPastMonth: Bool { month < currentMonth }

    private var plan: SmmPlan? { payload.value?.plan }
    private var posts: [SmmPost] { SmmPlanMath.ordered(payload.value?.posts ?? []) }
    private var busy: SmmBusy? { plan?.busy }
    private var hasPlan: Bool { plan?.summary.nonEmpty != nil }

    private var loadKey: String { "\(profile.rawValue)|\(month)" }

    /// Seconds between polls, `nil` when nothing is being worked on.
    private var pollSeconds: Int? {
        if busy != nil { return Self.busyPoll }
        return posts.contains(where: \.isWorking) ? Self.postsPoll : nil
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    content(proxy)
                }
                .padding(16)
                .animation(.smooth, value: busy)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background { AuraBackground() }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .safeAreaBar(edge: .top) { monthBar }
        .overlay {
            if payload.value == nil {
                RemoteStateOverlay(remote: payload, retry: load)
            }
        }
        .refreshable { await load() }
        .task(id: loadKey) {
            payload.reset()
            nextPlan = nil
            isOrdering = false
            await load()
        }
        .task(id: "\(loadKey)|\(pollSeconds ?? 0)") { await poll() }
        .remoteErrorAlert(payload)
        .errorAlert($errorMessage, title: "Не получилось")
        .alert(hasPlan ? "Пересоставить план?" : "Составить план", isPresented: $isAskingWishes) {
            TextField("Пожелания на месяц", text: $wishes)
            Button(hasPlan ? "Пересоставить" : "Составить") { generate() }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text(wishesPrompt)
        }
        .sensoryFeedback(.success, trigger: successCount)
        .sensoryFeedback(.selection, trigger: swapCount)
        .navigationTitle("План месяца")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Content

    @ViewBuilder
    private func content(_ proxy: ScrollViewProxy) -> some View {
        if let busy {
            SmmProgressBanner(progress: plan?.progress, text: busy.text)
        } else if let error = plan?.error.nonEmpty {
            SmmFailureBanner(text: error)
        }
        nextPlanBanner
        if let value = payload.value {
            if let plan = value.plan, hasPlan {
                planContent(plan, value: value, proxy: proxy)
            } else if busy == nil {
                emptyState
            }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label(isPastMonth ? "Плана на этот месяц не было" : "Плана пока нет", systemImage: "calendar.badge.plus")
        } description: {
            Text(emptyText)
        } actions: {
            if !isPastMonth {
                Button("Составить план", action: askWishes)
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
                    .disabled(action != nil)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 24)
    }

    @ViewBuilder
    private func planContent(_ plan: SmmPlan, value: SmmPlanPayload, proxy: ScrollViewProxy) -> some View {
        let occasions = SmmPlanMath.occasions(value.dates, month: month)
        SmmPlanStrategyCard(plan: plan)
        if !plan.pillars.isEmpty {
            SmmPlanPillarsCard(pillars: plan.pillars)
        }
        if !occasions.isEmpty {
            SmmPlanOccasionsCard(dates: occasions)
        }
        if plan.status == .draft, !isPastMonth {
            approveButton
        }
        publicationsHeader
        SmmPlanCalendar(
            month: month, posts: posts, dates: occasions, today: today, timeZone: timeZone,
            canCreate: !isPastMonth, onShowDay: { day in show(day, proxy: proxy) }
        )
        ForEach(SmmPlanMath.weeks(posts, month: month, timeZone: timeZone)) { week in
            weekBlock(week, occasions: SmmPlanMath.occasions(occasions, in: week))
        }
        remarks(value.comments)
    }

    @ViewBuilder
    private var nextPlanBanner: some View {
        if month == currentMonth, let next = nextPlan, next.summary.nonEmpty != nil {
            let nextMonth = SmmText.shiftMonth(month, by: 1)
            Button {
                withAnimation(.smooth) { month = nextMonth }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "calendar.badge.checkmark")
                        .foregroundStyle(Color.accentColor)
                    Text("План на \(SmmText.monthTitle(nextMonth).lowercased()) готов\(next.status == .draft ? " — утвердите" : "")")
                        .font(.subheadline)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .cardStyle(padding: 14)
                .contentShape(.rect(cornerRadius: Theme.cardRadius))
            }
            .buttonStyle(.plain)
        }
    }

    private var approveButton: some View {
        Button(action: approve) {
            ZStack {
                Label("Утвердить план", systemImage: "checkmark.seal")
                    .opacity(action == .approve ? 0 : 1)
                if action == .approve { ProgressView().tint(.white) }
            }
            .font(.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
        }
        .buttonStyle(.glassProminent)
        .controlSize(.large)
        .disabled(busy != nil || action != nil)
    }

    private var publicationsHeader: some View {
        let live = posts.filter { $0.status != .skipped }
        let movable = SmmPlanMath.movable(posts)
        return VStack(alignment: .leading, spacing: 6) {
            SmmGroupTitle("Публикации · \(live.count)") {
                if !isPastMonth, busy == nil, !isOrdering {
                    Button("Пересоставить", action: askWishes)
                        .disabled(action != nil)
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(isOrdering
                    ? "Стрелки меняют публикацию местами с соседней: время выхода переходит к ней."
                    : SmmPlanMath.countsLine(posts))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !isPastMonth, movable.count > 1 {
                    Button(isOrdering ? "Готово" : "Порядок") {
                        withAnimation(.snappy) { isOrdering.toggle() }
                    }
                    .font(.subheadline.weight(.semibold))
                }
            }
        }
    }

    private func weekBlock(_ week: SmmPlanWeek, occasions: [SmmDate]) -> some View {
        let movable = SmmPlanMath.movable(posts)
        return VStack(alignment: .leading, spacing: 8) {
            Text(week.title.uppercased())
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.leading, 4)
                .padding(.top, 4)
                .accessibilityAddTraits(.isHeader)
            ForEach(occasions) { date in
                SmmOccasionLine(date: date)
                    .padding(.horizontal, 4)
            }
            ForEach(week.posts) { post in
                postRow(post, movable: movable)
                    .id(post.id)
            }
        }
    }

    private func postRow(_ post: SmmPost, movable: [SmmPost]) -> some View {
        HStack(spacing: 10) {
            NavigationLink(value: SmmRoute.post(id: post.id)) {
                SmmPostRow(post: post, timeZone: timeZone, showsDay: true)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if isOrdering, let index = movable.firstIndex(where: { $0.id == post.id }) {
                orderArrows(post, index: index, count: movable.count)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .cardStyle(padding: 12)
    }

    private func orderArrows(_ post: SmmPost, index: Int, count: Int) -> some View {
        VStack(spacing: 6) {
            arrow("chevron.up", label: "Раньше", isEnabled: index > 0) { move(post, by: -1) }
            arrow("chevron.down", label: "Позже", isEnabled: index < count - 1) { move(post, by: 1) }
        }
        .overlay {
            if swappingId == post.id { ProgressView() }
        }
    }

    private func arrow(_ symbol: String, label: String, isEnabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.subheadline.weight(.semibold))
                .frame(width: 36, height: 30)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .disabled(!isEnabled || swappingId != nil)
        .accessibilityLabel(label)
    }

    private func remarks(_ comments: [SmmComment]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            SmmGroupTitle("Замечания к плану")
            if !comments.isEmpty {
                SmmThread(comments: comments)
            }
            ChatComposer(
                text: $remark,
                placeholder: "Перенеси, добавь, убери, больше рилс про процесс…",
                isSending: action == .remark,
                onSend: sendRemark
            )
            .padding(.horizontal, -12)
            .disabled(busy != nil)
            .opacity(busy != nil ? 0.5 : 1)
        }
        .padding(.bottom, 24)
    }

    private var monthBar: some View {
        HStack {
            monthButton("chevron.left", label: "Прошлый месяц", delta: -1)
            Spacer(minLength: 8)
            Text(SmmText.monthTitle(month))
                .font(.title3.weight(.semibold))
                .contentTransition(.numericText())
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            monthButton("chevron.right", label: "Следующий месяц", delta: 1)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private func monthButton(_ symbol: String, label: String, delta: Int) -> some View {
        Button {
            withAnimation(.smooth) { month = SmmText.shiftMonth(month, by: delta) }
        } label: {
            Image(systemName: symbol)
                .font(.headline)
                .frame(width: 30, height: 30)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel(label)
    }

    // MARK: - Texts

    private var emptyText: String {
        let subject = profile == .studio
            ? "студию — услуги, мастеров, украшения, свободные окна, что заходило в соцсетях"
            : "портрет «\(store.title(of: profile))» и что заходило в соцсетях"
        return "Маркетолог изучит \(subject) — и распишет месяц: стратегию, рубрики и темы по дням для Telegram и Instagram."
    }

    private var wishesPrompt: String {
        let replace = hasPlan ? "Темы, которые ещё не написаны, маркетолог заменит. Одобренные и вышедшие останутся. " : ""
        return replace + "Есть пожелания на месяц? (необязательно)"
    }

    // MARK: - Loading

    private func load() async {
        let profile = profile
        let month = month
        await payload.load { try await api.smmPlan(profile, month: month) }
        await loadNextPlan(profile: profile, month: month)
    }

    /// The next month's draft for the banner; a failure only hides the banner.
    private func loadNextPlan(profile: SmmProfile, month: String) async {
        guard month == currentMonth else {
            nextPlan = nil
            return
        }
        do {
            let next = try await api.smmPlan(profile, month: SmmText.shiftMonth(month, by: 1))
            guard profile == self.profile, month == self.month else { return }
            nextPlan = next.plan
        } catch is CancellationError {
            return
        } catch {
            logger.notice("SMM next plan load failed: \(error.userMessage, privacy: .public)")
        }
    }

    /// Asks again while the marketer works; a failed poll keeps what is on screen and tries on the next tick.
    private func poll() async {
        guard let seconds = pollSeconds else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            let profile = profile
            let month = month
            do {
                let fresh = try await api.smmPlan(profile, month: month)
                guard !Task.isCancelled, profile == self.profile, month == self.month else { return }
                withAnimation(.smooth) { payload.set(fresh) }
            } catch is CancellationError {
                return
            } catch {
                logger.notice("SMM plan poll failed: \(error.userMessage, privacy: .public)")
            }
        }
    }

    // MARK: - Actions

    private func askWishes() {
        wishes = ""
        isAskingWishes = true
    }

    private func generate() {
        let wishes = wishes.trimmed
        perform(.generate) { profile, month in
            try await api.generateSmmPlan(profile, month: month, wishes: wishes)
        }
    }

    private func approve() {
        perform(.approve) { profile, month in
            try await api.approveSmmPlan(profile, month: month)
        }
    }

    private func sendRemark() {
        let text = remark.trimmed
        guard text.count >= 2 else {
            errorMessage = "Напишите замечание подробнее."
            return
        }
        perform(.remark) { profile, month in
            let result = try await api.remarkSmmPlan(profile, month: month, text: text)
            remark = ""
            return result
        }
    }

    private func perform(_ kind: PlanAction, _ request: @escaping @MainActor (SmmProfile, String) async throws -> SmmPlanPayload) {
        guard action == nil else { return }
        let profile = profile
        let month = month
        action = kind
        Task {
            defer { action = nil }
            do {
                let result = try await request(profile, month)
                guard profile == self.profile, month == self.month else { return }
                withAnimation(.smooth) { payload.set(result) }
                successCount += 1
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
    }

    /// Swaps the post's time with its neighbour above or below among the posts not out yet.
    private func move(_ post: SmmPost, by delta: Int) {
        let movable = SmmPlanMath.movable(posts)
        guard swappingId == nil, let index = movable.firstIndex(where: { $0.id == post.id }),
              movable.indices.contains(index + delta) else { return }
        let other = movable[index + delta]
        let profile = profile
        swapCount += 1
        swappingId = post.id
        Task {
            defer { swappingId = nil }
            do {
                try await api.swapSmmPosts(profile, post.id, other.id)
                let fresh = try await api.smmPlan(profile, month: month)
                guard profile == self.profile else { return }
                withAnimation(.smooth) { payload.set(fresh) }
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
    }

    private func show(_ day: SmmPlanDay, proxy: ScrollViewProxy) {
        guard let first = day.posts.first else { return }
        withAnimation(.smooth) { proxy.scrollTo(first.id, anchor: .center) }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        SmmPlanView(month: "2026-11")
            .environment(SmmProfileStore())
    }
    .previewEnvironment()
}
#endif
