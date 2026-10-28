import CoreImage.CIFilterBuiltins
import SwiftUI

/// A crisp black-on-white QR code for `payload`, drawn on device with Core Image (one pixel per module,
/// scaled without interpolation, quiet zone included).
struct QRCodeImage: View {
    let payload: String
    var accessibilityLabel = "QR-код для оплаты"

    var body: some View {
        if let image = Self.render(payload) {
            Image(decorative: image, scale: 1)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .accessibilityLabel(accessibilityLabel)
        } else {
            ContentUnavailableView("Не удалось построить QR-код", systemImage: "qrcode")
        }
    }

    private static let context = CIContext()

    /// `moduleSize` — pixels per module: 1 for on-screen drawing (scaled without interpolation), more for a picture
    /// to share or print.
    static func render(_ payload: String, moduleSize: CGFloat = 1) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = moduleSize == 1 ? output : output.transformed(by: CGAffineTransform(scaleX: moduleSize, y: moduleSize))
        return context.createCGImage(scaled, from: scaled.extent)
    }
}

#if DEBUG
#Preview {
    QRCodeImage(payload: "https://qr.nspk.ru/AD10001B38T99KA99CD8S37FMTH8CFQ7?type=02&bank=100000000065&sum=300000&cur=RUB&crc=43B6")
        .padding(24)
        .background(.white, in: .rect(cornerRadius: 24))
        .padding()
}
#endif
