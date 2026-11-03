import SwiftUI
import os

/// Loads what checkout needs for bonuses: the studio's rules once, the client's balance and birthday discount
/// whenever the receipt's client changes. Without them (an older server, offline) checkout simply offers no bonuses.
struct CheckoutLoyaltyLoader: ViewModifier {
    @Environment(APIClient.self) private var api
    @Environment(CartStore.self) private var cart

    func body(content: Content) -> some View {
        content
            .task { await CheckoutLoyaltyLoading.loadRules(api: api, cart: cart) }
            .task(id: cart.client?.id) { await loadClient() }
    }

    private func loadClient() async {
        guard let clientId = cart.client?.id else { return }
        do {
            let client = try await api.client(id: clientId)
            // The cashier may have picked another client meanwhile.
            guard cart.client?.id == clientId else { return }
            cart.setClientLoyalty(client.loyalty, for: clientId)
        } catch is CancellationError {
            return
        } catch {
            CheckoutLoyaltyLoading.logger.notice("Client \(clientId) loyalty failed: \(error.userMessage, privacy: .public)")
        }
    }
}

enum CheckoutLoyaltyLoading {
    static let logger = Logger(subsystem: "com.mikanstudio.crm", category: "loyalty")

    /// `GET /settings/retention` into the cart (every checkout, so a change in settings applies at once).
    static func loadRules(api: APIClient, cart: CartStore) async {
        do {
            cart.setLoyaltyRules(CheckoutLoyaltyRules(try await api.retentionSettings()))
        } catch is CancellationError {
            return
        } catch {
            // Rules of another session or an older answer must not be used: no bonuses until they load.
            cart.setLoyaltyRules(nil)
            logger.notice("Loyalty rules failed: \(error.userMessage, privacy: .public)")
        }
    }
}

extension View {
    /// Bonuses and the birthday discount of the cart's client (see `CheckoutLoyaltyLoader`).
    func loadsCheckoutLoyalty() -> some View {
        modifier(CheckoutLoyaltyLoader())
    }
}
