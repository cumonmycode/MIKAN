import Foundation
import Observation

/// Cached reference data used by pickers: employees (masters), services, aftercare templates;
/// whether the server takes SBP QR payments; and the studio's working hours for the calendar.
@Observable
final class ReferenceStore {
    private static let workdayKey = "studio.workday"

    private let api: APIClient
    /// The last known hours survive restarts, so the calendar opens on the right range before the settings load.
    private(set) var workday: WorkdayHours = ReferenceStore.cachedWorkday() ?? .standard
    private var loadedWorkday = false
    private(set) var employees: [Employee] = []
    private(set) var services: [Service] = []
    private(set) var templates: [AftercareTemplate] = []
    /// Warehouse categories of every section, in staff order.
    private(set) var categories: [CatalogCategory] = []
    private(set) var qrPaymentsEnabled = false
    private var loadedEmployees = false
    private var loadedServices = false
    private var loadedTemplates = false
    private var loadedCategories = false

    init(api: APIClient) {
        self.api = api
    }

    /// Active employees who perform procedures.
    var masters: [Employee] { employees.filter { $0.isMaster && $0.active } }
    var activeServices: [Service] { services.filter(\.active) }

    func service(id: Int?) -> Service? {
        guard let id else { return nil }
        return services.first { $0.id == id }
    }

    func template(id: Int?) -> AftercareTemplate? {
        guard let id else { return nil }
        return templates.first { $0.id == id }
    }

    func ensureEmployees(force: Bool = false) async throws {
        guard force || !loadedEmployees else { return }
        employees = try await api.employees(includeInactive: true)
        loadedEmployees = true
    }

    func ensureServices(force: Bool = false) async throws {
        guard force || !loadedServices else { return }
        services = try await api.services(includeInactive: true)
        loadedServices = true
    }

    func ensureTemplates(force: Bool = false) async throws {
        guard force || !loadedTemplates else { return }
        templates = try await api.aftercareTemplates()
        loadedTemplates = true
    }

    func ensureCategories(force: Bool = false) async throws {
        guard force || !loadedCategories else { return }
        categories = try await api.catalogCategories()
        loadedCategories = true
    }

    /// Takes categories created, renamed, reordered or merged anywhere in the app.
    func replaceCategories(_ items: [CatalogCategory], section: CatalogSection) {
        categories = categories.filter { $0.section != section } + items
        loadedCategories = true
    }

    /// Takes one category created or renamed anywhere in the app, so every picker offers it at once.
    func upsertCategory(_ category: CatalogCategory) {
        if categories.contains(where: { $0.id == category.id }) {
            categories = categories.map { $0.id == category.id ? category : $0 }
        } else {
            categories = categories + [category]
        }
    }

    /// An item was saved with this category: the server registers a name it does not know, so ask for the registry
    /// again — otherwise the new category shows on the warehouse list but not in the pickers.
    func refreshCategoriesIfUnknown(_ name: String?, in scope: CategoryScope) async {
        guard let name = name?.nonEmpty, categories.named(name, in: scope) == nil else { return }
        try? await ensureCategories(force: true)
    }

    /// Asked again on every checkout until enabled, so turning QR on at the server needs no app restart.
    func ensureQrPaymentsConfig() async throws {
        guard !qrPaymentsEnabled else { return }
        qrPaymentsEnabled = try await api.qrPaymentsConfig().enabled
    }

    func replaceEmployees(_ items: [Employee]) {
        employees = items
        loadedEmployees = true
    }

    func replaceServices(_ items: [Service]) {
        services = items
        loadedServices = true
    }

    func ensureWorkday(force: Bool = false) async throws {
        guard force || !loadedWorkday else { return }
        applyStudioSettings(try await api.studioSettings())
    }

    /// Takes the working hours from settings loaded or saved anywhere in the app.
    func applyStudioSettings(_ settings: StudioSettings) {
        workday = WorkdayHours(settings: settings)
        loadedWorkday = true
        UserDefaults.standard.set([settings.workdayStart, settings.workdayEnd, settings.timezone], forKey: Self.workdayKey)
    }

    private static func cachedWorkday() -> WorkdayHours? {
        guard let parts = UserDefaults.standard.stringArray(forKey: workdayKey), parts.count == 3 else { return nil }
        return WorkdayHours(start: parts[0], end: parts[1], timeZoneIdentifier: parts[2])
    }

    func replaceTemplates(_ items: [AftercareTemplate]) {
        templates = items
        loadedTemplates = true
    }

    func reset() {
        employees = []
        services = []
        templates = []
        categories = []
        loadedCategories = false
        loadedEmployees = false
        loadedServices = false
        loadedTemplates = false
        loadedWorkday = false
        qrPaymentsEnabled = false
    }
}
