import SwiftUI
import UIKit

/// The printable gift certificate card: studio name, amount, code, valid until and recipient. Fixed size, so the
/// rendered picture looks the same on every phone.
struct CertificateCardView: View {
    let certificate: GiftCertificate
    let studioName: String

    static let size = CGSize(width: 360, height: 224)

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Theme.mandarinLight, Theme.mandarin, Theme.mandarinDeep],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Circle()
                .fill(.white.opacity(0.12))
                .frame(width: 220, height: 220)
                .offset(x: 150, y: -90)
            Circle()
                .fill(.white.opacity(0.08))
                .frame(width: 160, height: 160)
                .offset(x: -170, y: 110)
            content
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .clipShape(.rect(cornerRadius: 24))
        .environment(\.locale, .app)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(studioName.uppercased())
                    .font(.system(size: 15, weight: .heavy))
                    .tracking(2)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Spacer(minLength: 8)
                Image(systemName: "gift.fill").font(.system(size: 20, weight: .semibold))
            }
            Spacer(minLength: 6)
            Text("Подарочный сертификат")
                .font(.system(size: 14, weight: .semibold))
                .opacity(0.9)
            Text(Money.format(certificate.amount))
                .font(.system(size: 42, weight: .heavy, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            if let recipient = certificate.recipientName.nonEmpty {
                Text("Кому: \(recipient)")
                    .font(.system(size: 14, weight: .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Spacer(minLength: 6)
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Код").font(.system(size: 11, weight: .medium)).opacity(0.8)
                    Text(certificate.code)
                        .font(.system(size: 17, weight: .bold, design: .monospaced))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    Text("Действует").font(.system(size: 11, weight: .medium)).opacity(0.8)
                    Text(CertificateText.validity(certificate.expiresAt))
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
            }
        }
        .padding(20)
        .foregroundStyle(.white)
    }
}

/// Renders the card into a picture to share or print.
enum CertificateCardRenderer {
    static let defaultStudioName = "MIKAN STUDIO"
    private static let scale: CGFloat = 3

    static func image(for certificate: GiftCertificate, studioName: String) -> UIImage? {
        let renderer = ImageRenderer(
            content: CertificateCardView(certificate: certificate, studioName: studioName)
                .environment(\.colorScheme, .light)
        )
        renderer.scale = scale
        return renderer.uiImage
    }

    /// The system print sheet for the card picture.
    static func print(_ image: UIImage, code: String) {
        let info = UIPrintInfo(dictionary: nil)
        info.outputType = .photo
        info.jobName = "Сертификат \(code)"
        let controller = UIPrintInteractionController.shared
        controller.printInfo = info
        controller.printingItem = image
        controller.present(animated: true)
    }
}

/// The card with «Поделиться», «Печать» and «Отправить в Telegram» (`POST /certificates/:id/send` to the buyer's
/// linked chat). Rows of a list section.
struct CertificateCardActions: View {
    @Environment(APIClient.self) private var api
    let certificate: GiftCertificate

    @State private var studioName = CertificateCardRenderer.defaultStudioName
    @State private var image: UIImage?
    @State private var isSending = false
    @State private var sentCount = 0
    @State private var errorMessage: String?

    private var canSend: Bool { certificate.buyer?.telegramLinked == true }

    /// One list row: modifiers on several rows would run the render and show the alert once per row.
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: CertificateCardView.size.width)
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel(accessibilityText)
                HStack(spacing: 10) {
                    ShareLink(
                        item: Image(uiImage: image),
                        preview: SharePreview("Сертификат \(certificate.code)", image: Image(uiImage: image))
                    ) {
                        Label("Поделиться", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity)
                    }
                    Button {
                        CertificateCardRenderer.print(image, code: certificate.code)
                    } label: {
                        Label("Печать", systemImage: "printer").frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 120)
            }
            sendRow
        }
        .padding(.vertical, 4)
        .task(id: certificate) {
            await loadStudioName()
            image = CertificateCardRenderer.image(for: certificate, studioName: studioName)
        }
        .errorAlert($errorMessage, title: "Не отправлено")
        .sensoryFeedback(.success, trigger: sentCount)
    }

    @ViewBuilder
    private var sendRow: some View {
        // Bordered buttons: in one list row each answers only its own taps.
        Button(action: send) {
            HStack {
                Label(sentCount > 0 ? "Отправлено в Telegram" : "Отправить в Telegram", systemImage: sentCount > 0 ? "checkmark.circle.fill" : "paperplane")
                if isSending {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .disabled(!canSend || isSending)
        if !canSend {
            Text(certificate.buyer == nil
                ? "Сертификат продан без клиента — поделитесь карточкой."
                : "Клиент не подключил Telegram-бота — поделитесь карточкой.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var accessibilityText: String {
        var parts = ["Подарочный сертификат на \(Money.format(certificate.amount))", "код \(certificate.code)"]
        parts.append("действует \(CertificateText.validity(certificate.expiresAt))")
        if let recipient = certificate.recipientName.nonEmpty { parts.append("кому: \(recipient)") }
        return parts.joined(separator: ", ")
    }

    private func loadStudioName() async {
        do {
            if let name = try await api.studioSettings().name.nonEmpty { studioName = name }
        } catch is CancellationError {
            return
        } catch {
            // The card keeps the default name.
            CheckoutLoyaltyLoading.logger.notice("Studio name failed: \(error.userMessage, privacy: .public)")
        }
    }

    private func send() {
        isSending = true
        Task {
            defer { isSending = false }
            do {
                try await api.sendCertificate(id: certificate.id)
                sentCount += 1
            } catch {
                errorMessage = error.userMessage
            }
        }
    }
}

/// After a sale: the card of every certificate it issued, found by the code in the line's name.
struct IssuedCertificatesSection: View {
    let sale: Sale

    var body: some View {
        ForEach(sale.certificateItems) { item in
            IssuedCertificateSection(item: item)
        }
    }
}

private struct IssuedCertificateSection: View {
    @Environment(APIClient.self) private var api
    let item: SaleItem
    @State private var certificate = Remote<GiftCertificate>()

    var body: some View {
        Section {
            if let value = certificate.value {
                CertificateCardActions(certificate: value)
            } else if let failure = certificate.failure {
                VStack(alignment: .leading, spacing: 8) {
                    Text(failure).foregroundStyle(.secondary)
                    Button("Повторить") { Task { await load() } }
                        .buttonStyle(.bordered)
                }
            } else if item.certificateId == nil, item.issuedCertificateCode == nil {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.name)
                    Text("Карточка сертификата — в «Ещё» → «Сертификаты».")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                // Loads when the placeholder row shows (a task on the section would run once per row).
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .task { await load() }
            }
        } header: {
            Text("Подарочный сертификат")
        }
    }

    /// By the line's `certificateId`; an older server's line only names the code, which is looked up then.
    private func load() async {
        if let id = item.certificateId {
            await certificate.load { try await api.certificate(id: id) }
        } else if let code = item.issuedCertificateCode {
            await certificate.load { try await api.certificate(code: code) }
        }
    }
}

/// «+75 бонусов» on a sale that earned some.
struct SaleBonusEarnedSection: View {
    let sale: Sale

    var body: some View {
        if sale.earnedBonuses > 0 {
            Section {
                Label(BonusText.earned(sale.earnedBonuses), systemImage: "star.circle.fill")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(Theme.mandarin)
                    .monospacedDigit()
            } footer: {
                Text(sale.isRefunded ? "Начисленные бонусы списаны при возврате." : "Бонусы начислены на счёт клиента.")
            }
        }
    }
}

#if DEBUG
#Preview {
    CertificateCardView(certificate: PreviewData.certificate, studioName: "MIKAN STUDIO")
        .padding()
}
#endif
