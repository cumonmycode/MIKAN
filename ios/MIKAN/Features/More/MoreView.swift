import SwiftUI

struct MoreView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.permissions) private var permissions
    @State private var confirmsSignOut = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink { SmmHomeView() } label: {
                        Label("СММ-маркетолог", systemImage: "megaphone")
                    }
                    .badge(appState.badges.smmReview)
                }
                Section("Онлайн-запись") {
                    NavigationLink { OnlineBookingsView() } label: {
                        Label("Онлайн-записи", systemImage: "globe")
                    }
                    .badge(appState.badges.onlineAwaiting)
                    NavigationLink { WaitlistView() } label: {
                        Label("Лист ожидания", systemImage: "hourglass")
                    }
                    .badge(appState.badges.waitlist)
                    NavigationLink { BookingLinkView() } label: {
                        Label("Ссылка для записи", systemImage: "link")
                    }
                }
                Section("Бот") {
                    NavigationLink { ChatsListView() } label: {
                        Label("Чаты", systemImage: "bubble.left.and.bubble.right")
                    }
                    .badge(appState.badges.unreadChats)
                    NavigationLink { BookingRequestsView() } label: {
                        Label("Заявки", systemImage: "tray.and.arrow.down")
                    }
                    .badge(appState.badges.newBookingRequests)
                    NavigationLink { ScheduledMessagesView() } label: {
                        Label("Запланированные сообщения", systemImage: "clock.badge")
                    }
                    // A master does not change the bot's knowledge, memos or test it.
                    if permissions.editsSettings {
                        NavigationLink { KnowledgeListView() } label: {
                            Label("База знаний", systemImage: "books.vertical")
                        }
                        NavigationLink { AftercareTemplatesView() } label: {
                            Label("Шаблоны ухода", systemImage: "cross.case")
                        }
                        NavigationLink { BotTestView() } label: {
                            Label("Проверить бота", systemImage: "sparkles")
                        }
                    }
                    NavigationLink { BotSettingsView() } label: {
                        Label("Настройки бота", systemImage: "gearshape.2")
                    }
                }
                RetentionMoreSection()
                Section("Студия") {
                    if permissions.seesReports {
                        NavigationLink { ReportsView() } label: {
                            Label("Отчёты", systemImage: "chart.bar.xaxis")
                        }
                    }
                    NavigationLink { EmployeesListView() } label: {
                        Label("Сотрудники", systemImage: "person.3")
                    }
                    MastersPortfolioLink()
                    NavigationLink { PayrollView() } label: {
                        Label("Зарплата", systemImage: "banknote")
                    }
                    NavigationLink { StudioSettingsView() } label: {
                        Label("Настройки студии", systemImage: "building.2")
                    }
                    AuditLogMoreLink()
                }
                Section("Аккаунт") {
                    if let employee = appState.employee {
                        HStack(spacing: 12) {
                            InitialsAvatar(name: employee.name, color: .master(employee.color), size: 44)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(employee.name).font(.headline)
                                Text("@\(employee.login) · \(employee.role.title)").font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                        .accessibilityElement(children: .combine)
                        MyScheduleLink(employee: employee)
                        MyPortfolioLink(employee: employee)
                    }
                    NavigationLink { SecurityView() } label: {
                        Label("Безопасность", systemImage: "lock.shield")
                    }
                    Button("Выйти", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                        confirmsSignOut = true
                    }
                }
                Section {
                    LabeledContent("Сервер", value: appState.api.serverURL.host() ?? appState.api.serverURL.absoluteString)
                    LabeledContent("Версия", value: Self.appVersion)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            .auraBackground()
            .navigationTitle("Ещё")
            .refreshable { await appState.refreshBadges() }
            .confirmationDialog("Выйти из аккаунта?", isPresented: $confirmsSignOut, titleVisibility: .visible) {
                Button("Выйти", role: .destructive) { appState.signOut() }
                Button("Отмена", role: .cancel) {}
            }
        }
    }

    private static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String ?? "—"
        return "\(version) (\(build))"
    }
}

#if DEBUG
#Preview {
    MoreView()
        .previewEnvironment()
}
#endif
