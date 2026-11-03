import SwiftUI

/// A movement row that opens its delivery when the receipt came from one.
struct MovementLink: View {
    let movement: StockMovement
    var showsProduct = false
    var unit = ProductLimits.defaultUnit
    /// Inside a card rather than a list: plain style and its own chevron.
    var inCard = false

    var body: some View {
        if MovementText.isDelivery(movement), let deliveryId = movement.deliveryId {
            if inCard {
                link(deliveryId).buttonStyle(.plain)
            } else {
                link(deliveryId)
            }
        } else {
            MovementRow(movement: movement, showsProduct: showsProduct, unit: unit)
        }
    }

    private func link(_ deliveryId: Int) -> some View {
        NavigationLink {
            DeliveryDetailView(deliveryId: deliveryId)
        } label: {
            MovementRow(movement: movement, showsProduct: showsProduct, unit: unit, showsDisclosure: inCard)
        }
    }
}

/// Loads a product by id (a delivery line) and shows its card.
struct ProductLoaderView: View {
    @Environment(APIClient.self) private var api
    let productId: Int
    @State private var product = Remote<Product>()

    var body: some View {
        Group {
            if let value = product.value {
                ProductDetailView(product: value) { updated in product.set(updated) }
            } else {
                RemoteStateOverlay(remote: product, retry: load)
            }
        }
        .task {
            guard product.value == nil else { return }
            await load()
        }
    }

    private func load() async {
        await product.load { try await api.product(id: productId) }
    }
}
