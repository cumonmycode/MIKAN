import Foundation

// MARK: - Reads that work offline (docs/API.md «Offline mode (app)»)

extension APIClient {
    /// The app already knows it is offline: no network path, or the server stopped answering.
    var isKnownOffline: Bool {
        guard let connectivity else { return false }
        return !connectivity.isOnline
    }

    /// A GET whose answer is saved on the phone after every success and served from there while offline — at once when
    /// the app already knows it is offline, or after a request that could not reach the server. Other failures are
    /// thrown as they are.
    func cachedGet<T: Codable & Sendable>(_ dataset: OfflineDataset, _ fetch: () async throws -> T) async throws -> T {
        guard let cache = offlineCache else { return try await fetch() }
        if isKnownOffline, let copy = await cache.load(T.self, dataset) { return copy.payload }
        let outcome: Result<T, any Error>
        do {
            outcome = .success(try await fetch())
        } catch {
            outcome = .failure(error)
        }
        switch outcome {
        case .success(let value):
            await cache.save(value, as: dataset, at: .now)
            return value
        case .failure(let error):
            guard isKnownOffline, let copy = await cache.load(T.self, dataset) else { throw error }
            return copy.payload
        }
    }

    // MARK: Clients

    /// The client list: active clients are saved page by page and, offline, searched on the phone.
    func clients(search: String = "", archived: Bool = false, limit: Int = 50, offset: Int = 0) async throws -> ItemsResponse<Client> {
        guard let cache = offlineCache, !archived else {
            return try await fetchClients(search: search, archived: archived, limit: limit, offset: offset)
        }
        if isKnownOffline, let saved = await cache.load(ClientsSnapshot.self, .clients) {
            return saved.payload.page(search: search, limit: limit, offset: offset)
        }
        let outcome: Result<ItemsResponse<Client>, any Error>
        do {
            outcome = .success(try await fetchClients(search: search, archived: false, limit: limit, offset: offset))
        } catch {
            outcome = .failure(error)
        }
        switch outcome {
        case .success(let page):
            if search.trimmed.isEmpty {
                let items = page.items
                let total = page.total ?? offset + items.count
                await cache.update(ClientsSnapshot.self, .clients, at: .now) { saved in
                    ClientsSnapshot.saving(items, offset: offset, total: total, into: saved)
                }
            }
            return page
        case .failure(let error):
            guard isKnownOffline, let saved = await cache.load(ClientsSnapshot.self, .clients) else { throw error }
            return saved.payload.page(search: search, limit: limit, offset: offset)
        }
    }

    /// The saved active clients, shown by the list at once while the server is asked.
    func savedClients() async -> ClientsSnapshot? {
        guard let cache = offlineCache else { return nil }
        let saved = await cache.load(ClientsSnapshot.self, .clients)
        return saved?.payload
    }

    // MARK: Appointments

    /// One appointment; offline, its copy from the saved schedule (today ± 7 days).
    func appointment(id: Int) async throws -> Appointment {
        if isKnownOffline, let saved = await savedAppointment(id: id) { return saved }
        let outcome: Result<Appointment, any Error>
        do {
            outcome = .success(try await request(.get, "appointments/\(id)"))
        } catch {
            outcome = .failure(error)
        }
        switch outcome {
        case .success(let appointment):
            return appointment
        case .failure(let error):
            guard isKnownOffline, let saved = await savedAppointment(id: id) else { throw error }
            return saved
        }
    }

    private func savedAppointment(id: Int) async -> Appointment? {
        guard let cache = offlineCache else { return nil }
        let saved = await cache.load(ScheduleSnapshot.self, .schedule)
        return saved?.payload.appointment(id: id)
    }
}
