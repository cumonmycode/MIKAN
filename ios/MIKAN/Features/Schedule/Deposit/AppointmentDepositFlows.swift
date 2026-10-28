import SwiftUI

extension View {
    /// Presents the prepayment flows of the appointment card: the prepayment screen, refund, retain,
    /// the reminder and the refund-or-retain question after a cancellation / no-show (`decision`).
    func appointmentDepositFlows(
        _ flow: Binding<DepositFlow?>,
        appointment: Appointment,
        decision: DepositDecision? = nil,
        onChange: @escaping (Appointment) -> Void
    ) -> some View {
        modifier(AppointmentDepositFlows(flow: flow, appointment: appointment, decision: decision, onChange: onChange))
    }
}

private struct AppointmentDepositFlows: ViewModifier {
    @Environment(APIClient.self) private var api

    @Binding var flow: DepositFlow?
    let appointment: Appointment
    let decision: DepositDecision?
    let onChange: (Appointment) -> Void

    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var notice: DepositNotice?
    /// The retain sheet was asked for by the question after a cancellation (not by the card's «Удержать»).
    @State private var retainFollowsDecision = false
    @State private var successCount = 0

    private var held: String { Money.format(appointment.deposit) }

    func body(content: Content) -> some View {
        content
            .disabled(isWorking)
            .sheet(isPresented: shows(.collect)) {
                NavigationStack {
                    DepositCollectView(appointment: appointment, onChange: onChange) { flow = nil }
                }
            }
            .sheet(isPresented: shows(.refund)) {
                DepositRefundSheet(appointment: appointment) { updated in
                    onChange(updated)
                    successCount += 1
                }
            }
            .sheet(isPresented: shows(.retain), onDismiss: { retainFollowsDecision = false }) {
                DepositRetainSheet(appointment: appointment, amount: retainPrefill) { updated in
                    onChange(updated)
                    successCount += 1
                }
            }
            .confirmationDialog("Предоплата \(held)", isPresented: shows(.decide), titleVisibility: .visible) {
                decisionButtons
            } message: {
                Text(decision?.message ?? DepositDecision.fallbackMessage)
            }
            .onChange(of: flow) { _, newFlow in
                if newFlow == .remind { remind() }
            }
            .alert(notice?.title ?? "", isPresented: noticeShown) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(notice?.message ?? "")
            }
            .errorAlert($errorMessage)
            .sensoryFeedback(.success, trigger: successCount)
    }

    /// Refund-or-retain after a cancellation / no-show; only a refund of the remainder after an automatic retain.
    @ViewBuilder
    private var decisionButtons: some View {
        if let decision, decision.autoRetained > 0 {
            Button("Вернуть \(held)") { flow = .refund }
        } else if let decision, decision.suggestsRetain {
            Button("Удержать \(Money.format(decision.retainPrefill))", role: .destructive, action: retainAsDecided)
            Button("Вернуть клиенту") { flow = .refund }
        } else {
            Button("Вернуть клиенту") { flow = .refund }
            Button("Удержать", role: .destructive, action: retainAsDecided)
        }
        Button("Решить позже", role: .cancel) {}
    }

    /// From the card's «Удержать»: the rules' share of what is held; after a cancellation: what the question named.
    private var retainPrefill: Int {
        if retainFollowsDecision, let decision { return decision.retainPrefill }
        return DepositRules.retainPrefill(appointment)
    }

    private func retainAsDecided() {
        retainFollowsDecision = true
        flow = .retain
    }

    /// Presented while `flow` is `target`; dismissing clears it unless an action already moved on.
    private func shows(_ target: DepositFlow) -> Binding<Bool> {
        Binding(
            get: { flow == target },
            set: { isShown in
                if !isShown, flow == target { flow = nil }
            }
        )
    }

    private var noticeShown: Binding<Bool> {
        Binding(get: { notice != nil }, set: { if !$0 { notice = nil } })
    }

    private func remind() {
        isWorking = true
        Task {
            defer {
                isWorking = false
                if flow == .remind { flow = nil }
            }
            do {
                let result = try await api.remindDeposit(appointmentId: appointment.id)
                onChange(result.appointment)
                let text = DepositText.remindNotice(result)
                notice = DepositNotice(title: text.title, message: text.message)
                if result.sendError.nonEmpty == nil { successCount += 1 }
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

private struct DepositNotice {
    let title: String
    let message: String
}
