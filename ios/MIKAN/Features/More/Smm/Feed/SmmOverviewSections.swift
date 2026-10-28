import SwiftUI

// Sections of the SMM home around the feed (Titan `Hero`, `PlanCard`, tools and `Footer`).

/// Who runs the socials and how: autopilot or approval, the channel and Instagram with their numbers.
struct SmmHeroSection: View {
    let overview: SmmOverview

    private var channel: SmmAccount? { account(.telegram) }
    private var instagram: SmmAccount? { account(.instagram) }

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 14) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 52, height: 52)
                        .background(Color.accentColor.gradient, in: .rect(cornerRadius: 14))
                        .symbolEffect(.breathe, options: .repeat(.continuous))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Маркетолог ведёт соцсети")
                            .font(.title3.weight(.semibold))
                        Text(overview.autopilot
                             ? "Автопилот: Telegram выходит сам, вы можете остановить"
                             : "Готовит посты, вы одобряете — дальше сам")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 8) {
                    chip(.telegram, account: channel, fallback: "Канал не подключён", isReady: overview.ready.channel)
                    chip(.instagram, account: instagram, fallback: "Не подключён", isReady: overview.ready.instagram)
                }
            }
            .padding(.vertical, 6)
        }
    }

    private func account(_ platform: SmmAccountPlatform) -> SmmAccount? {
        overview.accounts.first { $0.platform == platform && $0.isActive }
    }

    private func chip(_ platform: SmmAccountPlatform, account: SmmAccount?, fallback: String, isReady: Bool) -> some View {
        let value = account?.followers.map { "\(SmmText.count($0)) подписч." } ?? (account?.title.nonEmpty ?? fallback)
        return HStack(spacing: 8) {
            SmmPlatformBadge(platform, size: 26)
            VStack(alignment: .leading, spacing: 1) {
                Text(platform.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
            }
            .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(8)
        .frame(maxWidth: .infinity)
        .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 14))
        .opacity(isReady ? 1 : 0.55)
        .accessibilityElement(children: .combine)
    }
}

/// What is not connected yet: the channel the bot posts to, Instagram, who posts by hand, approvers with Telegram.
struct SmmReadinessSection: View {
    let ready: SmmReadiness

    private var isComplete: Bool { ready.channel && ready.instagram && ready.publisher && ready.approvers > 0 }

    var body: some View {
        if !isComplete {
            Section {
                item("Канал Telegram", isOn: ready.channel,
                     on: "Бот публикует в канал", off: "Добавьте канал и сделайте бота @mikan_robot админом")
                item("Instagram", isOn: ready.instagram, on: "Подключён", off: "Не подключён")
                item("Кто выкладывает вручную", isOn: ready.publisher,
                     on: "Назначен", off: "Не выбран — рилс, сторис и Instagram без API некому передать")
                item("Одобряющие с Telegram", isOn: ready.approvers > 0,
                     on: Plural.count(ready.approvers, one: "человек", few: "человека", many: "человек"),
                     off: "Никого — превью на одобрение некуда прислать")
                NavigationLink(value: SmmRoute.settings) {
                    Label("Подключить в настройках", systemImage: "gearshape")
                }
                NavigationLink(value: SmmRoute.accounts) {
                    Label("Площадки", systemImage: "antenna.radiowaves.left.and.right")
                }
            } header: {
                Text("Готовность")
            }
        }
    }

    private func item(_ title: String, isOn: Bool, on: String, off: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: isOn ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(isOn ? .green : .orange)
                .font(.body)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.medium))
                Text(isOn ? on : off)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The month's strategy: summary and status of this month's plan, and next month's when it is ready.
struct SmmPlanSection: View {
    let overview: SmmOverview
    let profile: SmmProfile

    var body: some View {
        Section("Стратегия") {
            NavigationLink(value: SmmRoute.plan(month: overview.month)) {
                card(overview.plan)
            }
            if let next = overview.nextPlan, !next.summary.trimmed.isEmpty {
                NavigationLink(value: SmmRoute.plan(month: overview.nextMonth)) {
                    Label {
                        Text("План на \(SmmText.monthTitle(overview.nextMonth).lowercased()) готов\(next.status == .draft ? " — утвердите" : "")")
                    } icon: {
                        Image(systemName: "calendar.badge.clock")
                            .foregroundStyle(Color.accentColor)
                    }
                }
            }
        }
    }

    private func card(_ plan: SmmPlan?) -> some View {
        let hasSummary = !(plan?.summary.trimmed.isEmpty ?? true)
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("ПЛАН НА МЕСЯЦ")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(SmmText.monthTitle(overview.month))
                        .font(.title3.weight(.semibold))
                }
                Spacer()
                Image(systemName: "calendar")
                    .font(.title2)
                    .foregroundStyle(Color.accentColor)
            }
            if let busy = plan?.busy {
                SmmProgressBanner(progress: plan?.progress, text: busy.text)
            }
            Text(hasSummary ? (plan?.summary ?? "") : emptyText)
                .font(.subheadline)
                .lineLimit(4)
            Text(status(plan, hasSummary: hasSummary))
                .font(.footnote)
                .foregroundStyle(plan?.status == .active ? .green : .orange)
        }
        .padding(.vertical, 6)
    }

    private var emptyText: String {
        profile == .studio
            ? "Маркетолог составит стратегию на месяц: цели, рубрики и календарь публикаций по всем направлениям студии — тату, пирсинг, украшения, уход, мастера."
            : "Маркетолог составит стратегию на месяц: цели, рубрики и календарь публикаций по направлениям из настроек профиля."
    }

    private func status(_ plan: SmmPlan?, hasSummary: Bool) -> String {
        guard let plan, hasSummary else { return "Плана ещё нет" }
        return plan.status == .active ? "Утверждён — маркетолог готовит посты" : "Черновик — ждёт утверждения"
    }
}

/// The latest report of the marketer.
struct SmmLastReportSection: View {
    let report: SmmReport

    var body: some View {
        Section("Последний отчёт") {
            NavigationLink(value: SmmRoute.report(id: report.id)) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(report.title)
                        .font(.headline)
                    Text("\(SmmText.dayTitle(report.periodFrom)) — \(SmmText.dayTitle(report.periodTo))")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if !report.summary.trimmed.isEmpty {
                        Text(report.summary)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }
}

/// Analytics, ideas, the photo archive, the knowledge base and the marketer's memory; the profile's settings.
struct SmmToolsSections: View {
    let overview: SmmOverview?
    let profile: SmmProfile

    var body: some View {
        Section("Инструменты") {
            tile(.analytics, "Аналитика", "chart.xyaxis.line", .teal,
                 overview?.lastReport != nil ? "Есть свежий отчёт" : "Цифры, прогноз и факт")
            tile(.ideas, "Идеи", "lightbulb.fill", .orange, "По всем направлениям и праздникам")
            tile(.library(), "Фотоархив", "photo.stack.fill", .green,
                 profile == .studio ? "Фото студии для постов" : "Свои фото для постов")
            tile(.knowledge, "База знаний", "books.vertical.fill", .purple,
                 profile == .studio ? "Студия, места съёмки, даты" : "Портрет, места съёмки, даты")
            tile(.memory, "Память маркетолога", "brain", .pink, "Голос, правила, чего избегать")
        }
        Section("Настройки") {
            tile(.settings, "Настройки профиля", "gearshape.fill", .gray, "Голос, аудитория, частота, бюджет, одобряющие")
            tile(.accounts, "Площадки", "antenna.radiowaves.left.and.right", .blue, "Канал Telegram, Instagram и другие")
            tile(.instagram, "Instagram API", "camera.fill", .pink, "Публикация и цифры напрямую")
        }
    }

    private func tile(_ route: SmmRoute, _ title: String, _ symbol: String, _ tint: Color, _ subtitle: String) -> some View {
        NavigationLink(value: route) {
            HStack(spacing: 12) {
                Image(systemName: symbol)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 30)
                    .background(tint.gradient, in: .rect(cornerRadius: 8))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
    }
}

/// Neural network spend against the month's budget, the Polza balance and what went out this week.
struct SmmSpendSection: View {
    let overview: SmmOverview

    /// From this share of the budget the bar turns orange.
    private static let warningShare = 0.9

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                LabeledContent("Нейросети в этом месяце", value: spendText)
                if overview.spend.budget > 0 {
                    ProgressView(value: min(1, share))
                        .tint(share >= Self.warningShare ? .orange : .accentColor)
                        .accessibilityLabel("Бюджет израсходован на \(Int((share * 100).rounded())) %")
                }
            }
            if let balance = overview.balance {
                LabeledContent("Баланс Polza", value: Money.format(Int(balance.rounded(.down))))
            }
            LabeledContent("Вышло за неделю", value: "\(overview.counts.publishedWeek)")
        } header: {
            Text("Расходы")
        } footer: {
            if overview.spend.budget == 0 {
                Text("Бюджет на нейросети не ограничен — задайте его в настройках профиля.")
            }
        }
    }

    private var share: Double {
        overview.spend.budget > 0 ? Double(overview.spend.month) / Double(overview.spend.budget) : 0
    }

    private var spendText: String {
        let spent = Money.format(overview.spend.month)
        return overview.spend.budget > 0 ? "\(spent) из \(Money.format(overview.spend.budget))" : spent
    }
}
