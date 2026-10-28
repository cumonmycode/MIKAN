import SwiftUI

/// What the success screen shows about a sale that just went through.
nonisolated struct SaleOutcome: Hashable, Sendable {
    var sale: Sale
    /// Change for the cash the client handed over (not stored on the server).
    let cashChange: Int?
    /// Prepayment that stays held for the appointment because it was larger than the receipt.
    let depositRemainder: Int
    /// This checkout completed the appointment right before the sale.
    let completedVisit: Bool
    /// Aftercare memos scheduled by that completion.
    let scheduledMessages: Int
}

/// Paying the cart's receipt: completes the appointment first (a bare sale would mark it completed without aftercare),
/// then sells — or, with a QR share, shows the bank's QR code and lets the server sell once it is paid. The sale names
/// the open receipt, which the server deletes with it. One per receipt screen (`ReceiptFlowView`).
@Observable
final class ReceiptCheckout {
    enum Phase: Hashable {
        case editing
        case sold(SaleOutcome)
    }

    static let saleFailedTitle = "Продажа не проведена"

    private(set) var phase = Phase.editing
    /// The SBP QR code shown over the receipt while it waits for the payment. Leaving it unpaid lets the receipt be
    /// saved again.
    var qrPayment: QrPayment? {
        didSet { if qrPayment == nil, oldValue != nil { paymentSettled() } }
    }
    private(set) var isSubmitting = false
    var errorMessage: String?
    private(set) var errorTitle = ReceiptCheckout.saleFailedTitle
    /// «Продажа могла пройти»: the answer was lost; «Повторить» resends the same sale (same idempotency key). Until
    /// it is answered the sale may have deleted the receipt, so the receipt is not saved.
    var retryMessage: String? {
        didSet { if retryMessage == nil, oldValue != nil { paymentSettled() } }
    }

    /// Result of completing the appointment in this checkout (kept across a failed sale and its retry).
    @ObservationIgnored private var completion: CompleteAppointmentResult?
    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let cart: CartStore
    @ObservationIgnored private let receipts: OpenReceiptsStore
    @ObservationIgnored private let shift: ShiftStore
    @ObservationIgnored private let schedule: ScheduleStore

    init(state: AppState) {
        api = state.api
        cart = state.cart
        receipts = state.receipts
        shift = state.shift
        schedule = state.schedule
    }

    var isSold: Bool {
        if case .sold = phase { return true }
        return false
    }

    /// Being paid: the sale or the QR code is on its way, a QR code waits for the bank, or a lost answer waits for
    /// «Повторить». The receipt is neither re-read nor changed meanwhile.
    var isPaying: Bool { isSubmitting || qrPayment != nil || retryMessage != nil }

    // MARK: Paying

    func submit() {
        guard !isSubmitting else { return }
        let saleBody = cart.makeSaleBody()
        // The same cart resends the same key, so a retry after a lost response cannot create a second sale.
        let key = cart.saleIdempotencyKey(for: saleBody)
        let completeBody = cart.makeCompleteBody()
        let appointmentId = cart.appointmentId
        let cashChange = cart.cashChange
        isSubmitting = true
        // The sale carries the whole cart and deletes the receipt: no saves of it meanwhile.
        receipts.beginPayment()
        Task {
            defer {
                isSubmitting = false
                // Failed for sure: edits are saved again. A QR code waiting for the bank or a lost answer keeps the
                // receipt unsaved until it is settled (`paymentSettled`).
                if !isSold, qrPayment == nil, retryMessage == nil { receipts.endPayment() }
            }
            if let completeBody, let appointmentId {
                guard await completeAppointment(id: appointmentId, completeBody) else { return }
            }
            if saleBody.payments.qr > 0 {
                await startQrPayment(saleBody)
            } else {
                await createSale(saleBody, key: key, cashChange: cashChange)
            }
        }
    }

    /// A fresh code for the same cart after the previous one expired.
    func renewQrPayment() {
        let body = cart.makeSaleBody()
        isSubmitting = true
        Task {
            defer { isSubmitting = false }
            await startQrPayment(body)
        }
    }

    /// The bank confirmed the QR code and the server sold the cart.
    func qrPaid(_ sale: Sale) {
        sold(sale, cashChange: nil)
    }

    /// The bank has the money but the server could not sell the cart: it is finished by hand as a transfer.
    func qrPaidWithoutSale() {
        withAnimation(.smooth) {
            cart.moveQrShareToTransfer()
            qrPayment = nil
        }
    }

    /// Back to the receipt (cancelled, expired, or leaving a code that could not be cancelled).
    func leaveQr() {
        withAnimation(.smooth) { qrPayment = nil }
    }

    /// «Новая продажа» after a sale: a new empty receipt in the same screen.
    func startNewSale() async throws {
        try await receipts.openNew()
        completion = nil
        withAnimation(.smooth) { phase = .editing }
    }

    // MARK: Steps

    /// Idempotent on the server. On success the cart keeps the completed appointment, so a retry sends only the sale.
    private func completeAppointment(id: Int, _ body: CompleteBody) async -> Bool {
        do {
            let result = try await api.completeAppointment(id: id, body)
            cart.appointmentCompleted(result.appointment)
            completion = result
            return true
        } catch {
            showError(error.userMessage, title: "Запись не завершена")
            return false
        }
    }

    /// Nothing is sold yet: a lost response only leaves an unseen code behind, so no idempotency key is needed.
    private func startQrPayment(_ body: SaleBody) async {
        do {
            let payment = try await api.createQrPayment(body)
            withAnimation(.smooth) { qrPayment = payment }
        } catch {
            failed(error, title: "QR-код не создан")
        }
    }

    private func createSale(_ body: SaleBody, key: UUID, cashChange: Int?) async {
        do {
            sold(try await api.createSale(body, idempotencyKey: key), cashChange: cashChange)
        } catch let error as APIError where error.isOutcomeUnknown {
            retryMessage = "Связь прервалась до ответа сервера. Нажмите «Повторить» — если продажа уже прошла, второй раз она не проведётся."
        } catch {
            failed(error, title: Self.saleFailedTitle)
        }
    }

    private func failed(_ error: any Error, title: String) {
        showError(error.userMessage, title: title)
        let needsShift = (error as? APIError)?.status == 409
        let completedVisit = completion != nil
        // In the background, so the button is ready again at once.
        Task { [shift, schedule] in
            // «Откройте кассовую смену…»: the shift was closed elsewhere, the button turns into «Открыть смену».
            if needsShift { await shift.refresh() }
            // The appointment was completed even though the sale failed: show its new status in the schedule.
            if completedVisit { await schedule.refreshVisible() }
        }
    }

    /// Not sold, and nothing about the payment is pending any more: the receipt is saved again.
    private func paymentSettled() {
        guard !isSold, !isSubmitting else { return }
        receipts.endPayment()
    }

    private func sold(_ sale: Sale, cashChange: Int?) {
        let outcome = SaleOutcome(
            sale: sale,
            cashChange: cashChange,
            depositRemainder: sale.appointmentId == nil ? 0 : cart.depositRemainder,
            completedVisit: completion != nil,
            scheduledMessages: completion?.scheduledMessages ?? 0
        )
        withAnimation(.smooth) {
            phase = .sold(outcome)
            qrPayment = nil
        }
        // The success screen is ready at once: «Новая продажа» must not wait for the refreshes below.
        isSubmitting = false
        // The server deleted the paid receipt; the hub reloads its lists after the sale.
        receipts.receiptPaid()
        cart.recordCompletedSale()
        Task { [shift, schedule] in
            await shift.refresh()
            if sale.appointmentId != nil { await schedule.refreshVisible() }
        }
    }

    private func showError(_ message: String, title: String) {
        errorTitle = title
        errorMessage = message
    }
}
