import SwiftUI
import UIKit

/// «Ссылка для записи»: the booking page of the current server (`PUBLIC_URL/book`) with copy, share, a QR code and
/// where to put it. Open to every role.
struct BookingLinkView: View {
    /// Pixels per QR module of the shared picture (about 600 px wide).
    private static let sharedModuleSize: CGFloat = 16
    private static let copiedNoticeDuration: Duration = .seconds(2)

    @Environment(APIClient.self) private var api
    /// `false` — online booking is off in the studio settings; `nil` — not known here.
    var isEnabled: Bool? = nil

    @State private var copyCount = 0
    @State private var showsCopied = false

    private var link: URL { BookingLink.url(server: api.serverURL) }

    var body: some View {
        List {
            if isEnabled == false {
                Section {
                    Label(
                        "Онлайн-запись выключена: по ссылке клиенты увидят «Онлайн-запись временно недоступна». Включите её в настройках студии.",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .foregroundStyle(.orange)
                }
            }
            Section {
                VStack(spacing: 14) {
                    QRCodeImage(payload: link.absoluteString, accessibilityLabel: "QR-код ссылки для записи")
                        .frame(maxWidth: 220)
                        .padding(14)
                        .background(.white, in: .rect(cornerRadius: 20))
                    Text(link.absoluteString)
                        .font(.callout.monospaced())
                        .multilineTextAlignment(.center)
                        .textSelection(.enabled)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
            Section {
                Button(
                    showsCopied ? "Ссылка скопирована" : "Скопировать ссылку",
                    systemImage: showsCopied ? "checkmark" : "doc.on.doc",
                    action: copy
                )
                ShareLink(item: link, subject: Text("Онлайн-запись"), message: Text("Записаться онлайн:")) {
                    Label("Поделиться ссылкой", systemImage: "square.and.arrow.up")
                }
                if let picture = qrPicture {
                    ShareLink(item: picture, preview: SharePreview("QR-код для записи", image: picture)) {
                        Label("Поделиться QR-кодом", systemImage: "qrcode")
                    }
                }
            }
            Section {
                ForEach(BookingLinkPlace.all) { place in
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(place.title).font(.headline)
                            Text(place.detail)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: place.symbol)
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: {
                Text("Где разместить")
            } footer: {
                Text("Клиент сам выбирает услугу, мастера и свободное время. Новые записи появятся в «Ещё → Онлайн-записи», а на iPhone придёт уведомление.")
            }
        }
        .navigationTitle("Ссылка для записи")
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.success, trigger: copyCount)
        .task(id: copyCount) {
            guard copyCount > 0 else { return }
            do {
                try await Task.sleep(for: Self.copiedNoticeDuration)
                showsCopied = false
            } catch {
                // A newer copy restarted the notice.
                return
            }
        }
    }

    /// A large black-on-white QR picture for messengers and print.
    private var qrPicture: Image? {
        QRCodeImage.render(link.absoluteString, moduleSize: Self.sharedModuleSize)
            .map { Image(uiImage: UIImage(cgImage: $0)) }
    }

    private func copy() {
        UIPasteboard.general.string = link.absoluteString
        showsCopied = true
        copyCount += 1
    }
}

/// Where studios put their booking link.
private struct BookingLinkPlace: Identifiable {
    let id: String
    let title: String
    let detail: String
    let symbol: String

    static let all = [
        BookingLinkPlace(
            id: "instagram", title: "Instagram",
            detail: "В шапку профиля: «Редактировать профиль → Ссылки».", symbol: "camera"
        ),
        BookingLinkPlace(
            id: "yandex", title: "Яндекс Карты",
            detail: "В Яндекс Бизнесе, в карточку студии: кнопка «Записаться» или поле «Сайт».", symbol: "map"
        ),
        BookingLinkPlace(
            id: "2gis", title: "2ГИС",
            detail: "В личном кабинете 2ГИС, в карточку компании: ссылка на онлайн-запись.", symbol: "mappin.and.ellipse"
        ),
        BookingLinkPlace(
            id: "print", title: "QR-код",
            detail: "Распечатайте на стойку, визитки и зеркало у кресла.", symbol: "printer"
        ),
    ]
}

#if DEBUG
#Preview {
    NavigationStack {
        BookingLinkView(isEnabled: false)
    }
    .previewEnvironment()
}
#endif
