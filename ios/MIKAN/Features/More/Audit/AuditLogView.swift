import SwiftUI

/// «Журнал действий»: what was done in the studio, newest first, by day, filtered by employee and section.
/// With a card scope — «История изменений» of one appointment, client, sale or product.
/// Owner only: the server answers others with `403`, shown as the error state.
struct AuditLogView: View {
    @Environment(APIClient.self) private var api
    @Environment(ReferenceStore.self) private var reference
    @State private var model: AuditLogModel

    init(scope: AuditScope = .studio) {
        _model = State(initialValue: AuditLogModel(scope: scope))
    }

    /// The section caption is noise in a card's history or with one section picked.
    private var showsSection: Bool { model.scope.hasFilters && model.filter.section == nil }

    var body: some View {
        List {
            ForEach(model.days) { day in
                Section(AuditLogText.dayTitle(day.start)) {
                    ForEach(day.entries) { entry in
                        AuditEntryRow(entry: entry, showsSection: showsSection)
                            .task { await model.loadMoreIfNeeded(after: entry, api: api) }
                    }
                }
            }
            if model.isLoadingMore {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .safeAreaBar(edge: .top) {
            if model.scope.hasFilters {
                AuditFilterChips(filter: $model.filter, employees: reference.employees)
            }
        }
        .overlay {
            RemoteStateOverlay(remote: model.remote, retry: { await model.load(api: api) }) {
                emptyState
            }
        }
        .refreshable { await model.load(api: api) }
        .task(id: model.filter) { await model.loadIfNeeded(api: api) }
        // Only names the employees in the filter; the log itself works without them.
        .task {
            if model.scope.hasFilters { try? await reference.ensureEmployees() }
        }
        .remoteErrorAlert(model.remote)
        .navigationTitle(model.scope.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if model.scope.hasFilters {
                ToolbarItem(placement: .topBarTrailing) { filterMenu }
            }
        }
    }

    private var filterMenu: some View {
        Menu {
            Picker(selection: $model.filter.employeeId) {
                Text("Все сотрудники").tag(Int?.none)
                ForEach(AuditLogText.filterEmployees(reference.employees)) { employee in
                    Text(employee.name).tag(Int?.some(employee.id))
                }
            } label: {
                Label("Сотрудник", systemImage: "person.crop.circle")
            }
            .pickerStyle(.menu)
            Picker(selection: $model.filter.section) {
                Text("Все разделы").tag(AuditSection?.none)
                ForEach(AuditSection.allCases) { section in
                    Label(section.title, systemImage: section.symbol).tag(AuditSection?.some(section))
                }
            } label: {
                Label("Раздел", systemImage: "square.grid.2x2")
            }
            .pickerStyle(.menu)
            if model.filter.isActive {
                Button("Сбросить фильтры", systemImage: "xmark.circle") { model.filter = AuditFilter() }
            }
        } label: {
            Label(
                "Фильтр",
                systemImage: model.filter.isActive
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease.circle"
            )
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if model.filter.isActive {
            ContentUnavailableView {
                Label("Ничего не найдено", systemImage: "line.3.horizontal.decrease.circle")
            } description: {
                Text("Попробуйте выбрать другого сотрудника или раздел.")
            } actions: {
                Button("Сбросить фильтры") { model.filter = AuditFilter() }
                    .buttonStyle(.glassProminent)
            }
        } else {
            ContentUnavailableView(
                "Пока ничего не записано",
                systemImage: "list.bullet.rectangle",
                description: Text(model.scope.emptyDescription)
            )
        }
    }
}

/// The active filters under the title; tapping a chip drops that filter.
private struct AuditFilterChips: View {
    @Binding var filter: AuditFilter
    let employees: [Employee]

    var body: some View {
        if filter.isActive {
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 8) {
                    if let id = filter.employeeId {
                        chip(AuditLogText.employeeName(id, in: employees), systemImage: "person.crop.circle") {
                            filter.employeeId = nil
                        }
                    }
                    if let section = filter.section {
                        chip(section.title, systemImage: section.symbol) { filter.section = nil }
                    }
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.bottom, 4)
        }
    }

    private func chip(_ title: String, systemImage: String, clear: @escaping () -> Void) -> some View {
        Button {
            withAnimation(.snappy) { clear() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                Text(title).lineLimit(1)
                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .capsule)
        .accessibilityLabel("Фильтр: \(title). Сбросить")
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        AuditLogView()
    }
    .previewEnvironment()
}
#endif
