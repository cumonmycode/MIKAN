import SwiftUI

private enum PortfolioTileStyle {
    static let cornerRadius: CGFloat = 10
    static let shape = RoundedRectangle(cornerRadius: cornerRadius)
}

/// A square photo of the portfolio grid, with the tied service in a corner.
/// The caller sets the accessibility label (`PortfolioText.accessibilityLabel`).
struct PortfolioTile: View {
    @Environment(APIClient.self) private var api
    let photo: PortfolioPhoto
    var isBusy = false

    var body: some View {
        Color(.tertiarySystemFill)
            .aspectRatio(1, contentMode: .fit)
            .overlay { image }
            .overlay(alignment: .bottomLeading) { serviceBadge }
            .overlay {
                if isBusy {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(.ultraThinMaterial)
                }
            }
            .clipShape(PortfolioTileStyle.shape)
            .contentShape(.contextMenuPreview, PortfolioTileStyle.shape)
            .contentShape(.dragPreview, PortfolioTileStyle.shape)
            .contentShape(PortfolioTileStyle.shape)
    }

    private var image: some View {
        AsyncImage(url: api.mediaURL(for: photo.imageUrl), transaction: Transaction(animation: .easeOut(duration: 0.2))) { phase in
            switch phase {
            case .success(let picture):
                picture.resizable().scaledToFill()
            case .failure:
                Image(systemName: "photo.badge.exclamationmark")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            default:
                ProgressView()
            }
        }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var serviceBadge: some View {
        if let service = photo.service {
            Text(service.name)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(.ultraThinMaterial, in: .capsule)
                .padding(5)
                .accessibilityHidden(true)
        }
    }
}

/// The tile after the photos while a batch uploads: «3 из 5».
struct PortfolioUploadTile: View {
    let progress: PortfolioUploadProgress

    var body: some View {
        Color(.tertiarySystemFill)
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                VStack(spacing: 6) {
                    ProgressView()
                    Text("\(progress.current) из \(progress.total)")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            .clipShape(PortfolioTileStyle.shape)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Загрузка фото \(progress.current) из \(progress.total)")
    }
}
