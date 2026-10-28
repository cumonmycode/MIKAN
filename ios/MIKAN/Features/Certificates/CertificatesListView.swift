import Observation
import SwiftUI

/// Pages of gift certificates for a search (code or recipient) and a status filter.
@Observable
final class CertificatesListModel {
    static let pageSize = 50

    let remote = Remote<[GiftCertificate]>()
    var search = ""
    /// `nil` — every status.
    var status: GiftCertificateStatus?
    private(set) var total = 0
    private(set) var isLoadingMore = false

    var queryKey: String { "\(search)|\(status?.rawValue ?? "")" }

    func load(api: APIClient) async {
        let query = CertificateCode.searchQuery(search)
        let status = status
        await remote.load {
            let page = try await api.certificates(status: status, query: query, limit: Self.pageSize)
            // The search or filter changed while this page was loading: its own load shows the right list.
            guard query == CertificateCode.searchQuery(self.search), status == self.status else { throw CancellationError() }
            total = page.total ?? page.items.count
            return page.items
        }
    }

    func loadMoreIfNeeded(after certificate: GiftCertificate, api: APIClient) async {
        guard let items = remote.value, certificate.id == items.last?.id, items.count < total, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await api.certificates(
                status: status, query: CertificateCode.searchQuery(search), limit: Self.pageSize, offset: items.count
            )
            let known = Set(items.map(\.id))
            remote.update { $0 + page.items.filter { !known.contains($0.id) } }
            total = page.items.isEmpty ? items.count : (page.total ?? total)
        } catch is CancellationError {
            return
        } catch {
            remote.transientError = error.userMessage
        }
    }

    func upsert(_ certificate: GiftCertificate) {
        remote.upsert(certificate)
    }
}

/// «Сертификаты» in «Ещё»: every gift certificate, newest first, searchable by code or recipient.
struct CertificatesListView: View {
    @Environment(APIClient.self) private var api
    @State private var model = CertificatesListModel()

    private static let searchDebounce: Duration = .milliseconds(300)

    var body: some View {
        List {
            Section {
                StatusChips(selection: $model.status)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            Section {
                ForEach(model.remote.value ?? []) { certificate in
                    NavigationLink {
                        CertificateDetailView(certificate: certificate) { model.upsert($0) }
                    } label: {
                        CertificateRow(certificate: certificate)
                    }
                    .task { await model.loadMoreIfNeeded(after: certificate, api: api) }
                }
                if model.isLoadingMore {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
        }
        .auraBackground()
        .searchable(text: $model.search, prompt: "Код или кому")
        .overlay {
            RemoteStateOverlay(remote: model.remote, retry: { await model.load(api: api) }) {
                emptyState
            }
        }
        .refreshable { await model.load(api: api) }
        .task(id: model.queryKey) {
            if !model.search.isEmpty {
                try? await Task.sleep(for: Self.searchDebounce)
                guard !Task.isCancelled else { return }
            }
            await model.load(api: api)
        }
        .remoteErrorAlert(model.remote)
        .navigationTitle("Сертификаты")
    }

    @ViewBuilder
    private var emptyState: some View {
        if !model.search.trimmed.isEmpty {
            ContentUnavailableView.search(text: model.search)
        } else if model.status != nil {
            ContentUnavailableView("Таких сертификатов нет", systemImage: PaymentLine.certificateSymbol)
        } else {
            ContentUnavailableView(
                "Сертификатов пока нет",
                systemImage: PaymentLine.certificateSymbol,
                description: Text("Продайте подарочный сертификат в кассе: кнопка «Сертификат» на экране чека.")
            )
        }
    }
}

private struct StatusChips: View {
    @Binding var selection: GiftCertificateStatus?

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                chip(nil)
                ForEach(GiftCertificateStatus.filters, id: \.self) { chip($0) }
            }
            .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
        .sensoryFeedback(.selection, trigger: selection)
    }

    @ViewBuilder
    private func chip(_ status: GiftCertificateStatus?) -> some View {
        let isSelected = selection == status
        let button = Button(CertificateText.filterTitle(status)) {
            withAnimation(.snappy) { selection = status }
        }
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        if isSelected {
            button.buttonStyle(.borderedProminent)
        } else {
            button.buttonStyle(.bordered)
        }
    }
}

struct CertificateRow: View {
    let certificate: GiftCertificate

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: PaymentLine.certificateSymbol)
                .font(.subheadline)
                .foregroundStyle(certificate.isActive ? Color.accentColor : .secondary)
                .frame(width: 30, height: 30)
                .background(.fill.tertiary, in: .circle)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(certificate.code).font(.headline.monospaced()).lineLimit(1)
                    Spacer(minLength: 8)
                    MoneyText(certificate.balance).font(.headline)
                }
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .monospacedDigit()
                CertificateStatusBadge(status: certificate.status)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String {
        var parts = ["из \(Money.format(certificate.amount))"]
        if let recipient = certificate.recipientName.nonEmpty { parts.append("кому: \(recipient)") }
        if certificate.isActive { parts.append(CertificateText.validity(certificate.expiresAt)) }
        return parts.joined(separator: " · ")
    }
}

/// «Сертификаты» row of «Ещё».
struct CertificatesMoreLink: View {
    var body: some View {
        NavigationLink { CertificatesListView() } label: {
            Label("Сертификаты", systemImage: PaymentLine.certificateSymbol)
        }
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        CertificatesListView()
    }
    .previewEnvironment()
}
#endif
