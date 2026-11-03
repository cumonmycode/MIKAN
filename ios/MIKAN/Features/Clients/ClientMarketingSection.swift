import SwiftUI

/// Client card: «Получать новости и акции» — the inverse of `marketingOptOut` (campaigns, birthday and win-back
/// messages). Hidden when the server does not send the field yet.
struct ClientMarketingSection: View {
    @Environment(APIClient.self) private var api
    let client: Client
    /// The card's error alert (an alert inside a list section is not reliable).
    @Binding var errorMessage: String?
    let onChange: (Client) -> Void

    /// The value shown while the change is being saved.
    @State private var pending: Bool?

    var body: some View {
        if let optOut = client.marketingOptOut {
            Section {
                Toggle(isOn: Binding(get: { pending ?? !optOut }, set: save)) {
                    Label("Получать новости и акции", systemImage: "megaphone")
                }
                .disabled(pending != nil)
            } footer: {
                Text("Рассылки, поздравление с днём рождения и «давно не виделись». Напоминания о записи и памятки по уходу приходят всегда. Клиент может отписаться и сам — кнопкой под рассылкой.")
            }
        }
    }

    private func save(receives: Bool) {
        pending = receives
        Task {
            defer { pending = nil }
            do {
                onChange(try await api.setClientMarketingOptOut(id: client.id, optOut: !receives))
            } catch is CancellationError {
                return
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}
