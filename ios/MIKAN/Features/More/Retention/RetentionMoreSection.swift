import SwiftUI

/// More → «Лояльность»: campaigns (owner, admin), gift certificates and the retention settings (a master reads them).
struct RetentionMoreSection: View {
    @Environment(\.permissions) private var permissions

    var body: some View {
        Section("Лояльность") {
            if permissions.runsCampaigns {
                NavigationLink { CampaignsView() } label: {
                    Label("Рассылки", systemImage: "megaphone")
                }
            }
            CertificatesMoreLink()
            NavigationLink { RetentionSettingsView() } label: {
                Label("Удержание клиентов", systemImage: "heart.text.square")
            }
        }
    }
}
