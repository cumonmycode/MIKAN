import Foundation

// MARK: - Online booking and push devices (docs/API.md «Online booking», «Push notifications»)

extension APIClient {
    /// Unsettled online bookings in that state, sorted by start.
    func onlineBookings(state: OnlineBookingState) async throws -> [Appointment] {
        let response: ItemsResponse<Appointment> = try await request(
            .get, "appointments",
            query: queryItems(["onlineState": state.rawValue])
        )
        return response.items
    }

    /// Confirms a booking waiting for staff: the client is told.
    func confirmOnlineBooking(id: Int) async throws -> Appointment {
        try await request(.post, "appointments/\(id)/online/confirm")
    }

    /// Cancels an unsettled booking; the client gets the reason and the booking link.
    func rejectOnlineBooking(id: Int, reason: String) async throws -> Appointment {
        try await request(.post, "appointments/\(id)/online/reject", body: OnlineRejectBody(reason: reason))
    }

    /// Registers this iPhone for the signed-in employee's push notifications.
    func registerDevice(_ body: DeviceBody) async throws {
        try await requestVoid(.post, "devices", body: body)
    }

    /// Stops push notifications to this iPhone (on sign-out).
    func unregisterDevice(token: String) async throws {
        try await requestVoid(.delete, "devices/\(token)")
    }
}
