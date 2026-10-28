import Foundation
import Observation
import os

/// Open receipts shared by every device (`/receipts`) and saving of the one being edited in the cart.
///
/// The cart's receipt is saved with `PUT /receipts/:id` shortly after each change, one request at a time, and
/// flushed when the receipt screen is left or another receipt is opened. Saving never blocks the cashier: checkout
/// builds the sale from the local cart. A failed save keeps the edits and is retried on the next change; a `404`
/// means the receipt was paid or deleted on another device.
@Observable
final class OpenReceiptsStore {
    /// Pause after the last change before the receipt is saved.
    static let saveDelay: Duration = .milliseconds(700)
    static let goneMessage = "Чек уже оплачен или удалён на другом устройстве"

    /// The hub list, oldest first.
    let list = Remote<[OpenReceipt]>()
    /// Why the last save of the cart's receipt failed; the edits are kept and sent with the next change.
    private(set) var saveError: String?
    var saveFailed: Bool { saveError != nil }
    /// The cart's receipt turned out paid or deleted elsewhere (shown as an alert; the cart is cleared).
    var goneNotice: String?

    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let cart: CartStore
    @ObservationIgnored private let logger = Logger(subsystem: "com.mikanstudio.crm", category: "receipts")
    /// What the server holds for the cart's receipt: after loading it or the last successful save.
    @ObservationIgnored private var saved: SavedReceipt?
    /// The newest server copy of the cart's receipt (opening it again prefers it to an older list row).
    @ObservationIgnored private var latest: OpenReceipt?
    @ObservationIgnored private var debounce: Task<Void, Never>?
    @ObservationIgnored private var saving: Task<Void, Never>?
    /// A receipt being paid or deleted: it is not saved, and a `404` for it is expected.
    @ObservationIgnored private var closingId: Int?
    /// Created by «Новый чек»: deleted again when it is left without anything in it.
    @ObservationIgnored private var newBlankId: Int?
    /// The receipt screen just closed: its last save, or deleting a «Новый чек» left empty (see `leaveInBackground`).
    @ObservationIgnored private var leaving: Task<Void, Never>?
    @ObservationIgnored private var createKey = IdempotencyKey()

    init(api: APIClient, cart: CartStore) {
        self.api = api
        self.cart = cart
    }

    // MARK: List

    /// Waits for a closing receipt to be saved or deleted, so the list never brings back what was just deleted.
    func refresh() async {
        await leaving?.value
        await list.load { try await api.openReceipts() }
    }

    /// Background polling: a failure is only logged, so an offline hub does not show an alert every few seconds.
    func refreshQuietly() async {
        await leaving?.value
        do {
            list.set(try await api.openReceipts())
        } catch is CancellationError {
            return
        } catch {
            logger.notice("Open receipts refresh failed: \(error.userMessage, privacy: .public)")
        }
    }

    // MARK: Opening

    /// «Новый чек» (or «Продать» for a client): a new receipt in the cart. One left empty is deleted on leaving.
    func openNew(for client: ClientRef? = nil) async throws {
        let receipt = try await create(.blank(clientId: client?.id))
        try await open(receipt)
        newBlankId = receipt.id
    }

    /// «Начать визит»: the appointment's receipt with its services, client and prepayment — or the one another
    /// device has already opened for it. Returns it.
    @discardableResult
    func startVisit(_ appointment: Appointment) async throws -> OpenReceipt {
        let receipt = try await create(.visit(appointmentId: appointment.id))
        try await open(receipt)
        return receipt
    }

    /// Puts `receipt` into the cart. The receipt being edited is saved first; a «Новый чек» left empty is deleted.
    /// Edits that could not be saved are never dropped: the same receipt stays as it is in the cart, and another one
    /// is not opened (`UnsavedReceiptError`).
    func open(_ receipt: OpenReceipt) async throws {
        if cart.receiptId == receipt.id {
            await flush()
            guard pendingSave == nil else { return }
        } else {
            await leave()
            guard pendingSave == nil else { throw UnsavedReceiptError(reason: saveError) }
        }
        let fresh = OpenReceiptList.newer(receipt, latest)
        cart.load(fresh)
        remember(fresh)
        if newBlankId != fresh.id { newBlankId = nil }
    }

    /// Re-reads the cart's receipt (receipt screen, checkout): one paid or deleted on another device is let go with
    /// the notice, so it is not paid twice; a newer copy edited elsewhere replaces the cart while nothing here waits
    /// to be saved. Offline the cart just carries on.
    func syncCart() async {
        guard let id = cart.receiptId, id != closingId else { return }
        do {
            let receipt = try await api.openReceipt(id: id)
            // Paid, deleted or switched meanwhile: the answer is stale.
            guard cart.receiptId == id, id != closingId else { return }
            list.update { OpenReceiptList.upserting(receipt, into: $0) }
            guard saving == nil, pendingSave == nil else { return }
            // Only a copy newer than the one the cart was loaded from (or last saved) replaces it.
            if let latest, receipt.updatedAt <= latest.updatedAt { return }
            cart.load(receipt)
            remember(receipt)
        } catch let error as APIError where error.status == 404 {
            receiptGone(id: id)
        } catch {
            logger.notice("Receipt \(id) refresh failed: \(error.userMessage, privacy: .public)")
        }
    }

    /// `leave()` for a receipt screen that just closed, without waiting; list refreshes wait for it.
    func leaveInBackground() {
        let previous = leaving
        leaving = Task { [weak self] in
            await previous?.value
            await self?.leave()
        }
    }

    /// The receipt screen was closed: saves what is pending; a «Новый чек» left without anything is deleted.
    func leave() async {
        await flush()
        guard let id = cart.receiptId, id == newBlankId, cart.isBlank else { return }
        newBlankId = nil
        do {
            try await delete(id: id)
        } catch {
            // It stays in the hub, where it can be deleted by hand.
            logger.notice("Deleting an empty receipt failed: \(error.userMessage, privacy: .public)")
        }
    }

    private func create(_ body: ReceiptBody) async throws -> OpenReceipt {
        // The same key for a retry of the same action, so a lost response does not open a second receipt.
        let receipt = try await api.createReceipt(body, idempotencyKey: createKey.key(for: body))
        createKey.reset()
        list.update { OpenReceiptList.upserting(receipt, into: $0) }
        return receipt
    }

    // MARK: Deleting

    /// Deletes an open receipt: nothing is sold or returned, a prepayment stays held. Clears the cart if it holds it.
    func delete(id: Int) async throws {
        if cart.receiptId == id {
            debounce?.cancel()
            closingId = id
        }
        defer { if closingId == id { closingId = nil } }
        do {
            try await api.deleteReceipt(id: id)
        } catch {
            if cart.receiptId == id {
                closingId = nil
                cartDidChange()
            }
            throw error
        }
        list.remove(id: id)
        guard cart.receiptId == id else { return }
        forget()
        cart.clear()
    }

    /// The server deleted the receipt of a cancelled or no-show appointment.
    func forgetReceipt(ofAppointment appointmentId: Int) {
        list.update { receipts in receipts.filter { $0.appointment?.id != appointmentId } }
        guard cart.appointmentId == appointmentId else { return }
        debounce?.cancel()
        forget()
        cart.clear()
    }

    // MARK: Paying

    /// The sale is being sent: it carries the whole cart and deletes the receipt, so the receipt is not saved now.
    func beginPayment() {
        debounce?.cancel()
        closingId = cart.receiptId
    }

    /// The payment did not go through, or waits for a QR code: saving resumes.
    func endPayment() {
        closingId = nil
        cartDidChange()
    }

    /// The sale went through and the server deleted the receipt. Call before `CartStore.recordCompletedSale()`.
    func receiptPaid() {
        debounce?.cancel()
        closingId = nil
        if let id = cart.receiptId { list.remove(id: id) }
        forget()
    }

    // MARK: Saving

    /// The cart changed: saves it after a short pause (every further change restarts the pause).
    func cartDidChange() {
        debounce?.cancel()
        guard pendingSave != nil else { return }
        debounce = Task { [weak self] in
            try? await Task.sleep(for: Self.saveDelay)
            guard !Task.isCancelled else { return }
            await self?.save()
        }
    }

    /// Saves the cart's receipt now and returns once the server has it (or the save failed).
    func flush() async {
        debounce?.cancel()
        debounce = nil
        await save()
    }

    private func save() async {
        if saving == nil {
            saving = Task { [weak self] in
                await self?.drain()
                self?.saving = nil
            }
        }
        await saving?.value
    }

    /// What still has to reach the server: the cart's receipt when it differs from the saved copy.
    private var pendingSave: SavedReceipt? {
        guard let id = cart.receiptId, id != closingId else { return nil }
        let pending = SavedReceipt(id: id, body: cart.makeReceiptBody())
        return pending == saved ? nil : pending
    }

    /// One request at a time until the server has what the cart shows, or a save fails.
    private func drain() async {
        while let pending = pendingSave {
            do {
                let receipt = try await api.updateReceipt(id: pending.id, pending.body)
                // The cart may have been paid, deleted or switched meanwhile: then the answer is stale.
                guard cart.receiptId == pending.id else { return }
                saved = pending
                latest = receipt
                saveError = nil
                list.update { OpenReceiptList.upserting(receipt, into: $0) }
            } catch is CancellationError {
                return
            } catch let error as APIError where error.status == 404 {
                receiptGone(id: pending.id)
                return
            } catch {
                logger.notice("Saving receipt \(pending.id) failed: \(error.userMessage, privacy: .public)")
                if cart.receiptId == pending.id { saveError = error.userMessage }
                return
            }
        }
    }

    /// Paid or deleted on another device: the cart lets it go and the hub explains why.
    private func receiptGone(id: Int) {
        list.remove(id: id)
        guard cart.receiptId == id, closingId != id else { return }
        forget()
        cart.clear()
        goneNotice = Self.goneMessage
    }

    private func remember(_ receipt: OpenReceipt) {
        saved = SavedReceipt(id: receipt.id, body: cart.makeReceiptBody())
        latest = receipt
        saveError = nil
    }

    private func forget() {
        saved = nil
        latest = nil
        saveError = nil
        newBlankId = nil
    }

    /// Sign-out: nothing of the previous session stays.
    func reset() {
        debounce?.cancel()
        debounce = nil
        forget()
        closingId = nil
        goneNotice = nil
        list.reset()
    }
}

/// The receipt id with the body last sent for it.
nonisolated private struct SavedReceipt: Equatable {
    let id: Int
    let body: ReceiptBody
}

/// Another receipt is not opened while the cart's one could not be saved: its edits would be lost.
nonisolated struct UnsavedReceiptError: LocalizedError, Sendable {
    /// Why the save failed (the server's or the network's message).
    let reason: String?

    var errorDescription: String? {
        let prefix = "Открытый сейчас чек не сохранён, поэтому другой не открыт."
        guard let reason else { return prefix }
        return "\(prefix) \(reason)"
    }
}

/// Pure helpers for the hub list of open receipts.
nonisolated enum OpenReceiptList {
    /// Replaces the receipt with the same id, or appends it (the list is oldest first).
    static func upserting(_ receipt: OpenReceipt, into receipts: [OpenReceipt]) -> [OpenReceipt] {
        guard let index = receipts.firstIndex(where: { $0.id == receipt.id }) else { return receipts + [receipt] }
        var result = receipts
        result[index] = receipt
        return result
    }

    /// `candidate` when it is a newer copy of the same receipt, otherwise `receipt`.
    static func newer(_ receipt: OpenReceipt, _ candidate: OpenReceipt?) -> OpenReceipt {
        guard let candidate, candidate.id == receipt.id, candidate.updatedAt > receipt.updatedAt else { return receipt }
        return candidate
    }
}
