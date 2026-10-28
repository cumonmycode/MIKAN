import SwiftUI

/// «Визит»: completing the appointment (and sending the aftercare memo) right before the sale. Shown only while the
/// receipt's appointment is not completed yet.
struct ReceiptVisitSection: View {
    @Environment(CartStore.self) private var cart
    @Environment(ReferenceStore.self) private var reference

    var body: some View {
        @Bindable var cart = cart
        if let appointment = cart.appointment, cart.hasPendingAppointment {
            // The server sends a memo only for a fresh piercing / tattoo among the visit's services.
            let hasFreshProcedure = AftercareDefaults.sendsMemo(for: appointment, services: reference.services)
            let canSend = cart.canSendAftercare && hasFreshProcedure
            Section {
                Toggle("Завершить визит", isOn: $cart.completesAppointment)
                    .frame(minHeight: 44)
                Toggle(isOn: Binding(
                    get: { cart.sendsAftercare && canSend && cart.completesAppointment },
                    set: { cart.sendsAftercare = $0 }
                )) {
                    Text("Отправить памятку")
                    if let hint = memoHint(canSendToClient: cart.canSendAftercare, hasFreshProcedure: hasFreshProcedure) {
                        Text(hint)
                    }
                }
                .frame(minHeight: 44)
                .disabled(!canSend || !cart.completesAppointment)
            } header: {
                Text("Визит")
            } footer: {
                if !cart.completesAppointment {
                    Text("После оплаты запись всё равно отметится завершённой, но без памятки по уходу.")
                }
            }
        }
    }

    private func memoHint(canSendToClient: Bool, hasFreshProcedure: Bool) -> String? {
        if !canSendToClient { return "Клиент не подключил Telegram-бота" }
        if !hasFreshProcedure { return AftercareDefaults.noFreshProcedureHint }
        return cart.sendsAftercare && cart.completesAppointment ? "Придёт клиенту в Telegram по шаблону услуги" : nil
    }
}
