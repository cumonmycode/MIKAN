import SwiftUI

struct MainTabView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        @Bindable var appState = appState
        TabView(selection: $appState.selectedTab) {
            Tab("Запись", systemImage: "calendar", value: AppTab.schedule) {
                ScheduleView()
                    .offlineBanner()
            }
            Tab("Клиенты", systemImage: "person.2", value: AppTab.clients) {
                ClientsListView()
                    .offlineBanner()
            }
            Tab("Касса", systemImage: "rublesign.circle", value: AppTab.pos) {
                POSView()
                    .offlineBanner()
            }
            Tab("Склад", systemImage: "shippingbox", value: AppTab.inventory) {
                InventoryView()
                    .offlineBanner()
            }
            .badge(appState.badges.lowStock)
            Tab("Ещё", systemImage: "ellipsis.circle", value: AppTab.more) {
                MoreView()
                    .offlineBanner()
            }
            .badge(appState.moreBadge)
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .tabViewBottomAccessory {
            ShiftAccessoryView()
        }
        // A tapped push notification: the appointment, the chat or the requests, over the current tab.
        .sheet(item: $appState.pushRoute) { route in
            PushRouteView(route: route)
        }
        // The cart's receipt turned out paid or deleted on another phone while it was not on screen.
        .errorAlert(receiptGoneNotice, title: "Чек закрыт")
    }

    private var receiptGoneNotice: Binding<String?> {
        Binding(
            get: { appState.isReceiptOpen ? nil : appState.receipts.goneNotice },
            set: { appState.receipts.goneNotice = $0 }
        )
    }
}

/// Compact cash-shift status in the tab bar accessory; tap switches to «Касса».
struct ShiftAccessoryView: View {
    @Environment(AppState.self) private var appState
    @Environment(ShiftStore.self) private var shift
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement

    var body: some View {
        Button {
            appState.selectedTab = .pos
        } label: {
            HStack(spacing: 10) {
                Circle()
                    .fill(shift.current == nil ? Color.secondary : Color.green)
                    .frame(width: 8, height: 8)
                Text(statusText)
                    .font(.subheadline.weight(.medium))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(statusText)
        .accessibilityHint("Открыть кассу")
    }

    private var statusText: String {
        guard let current = shift.current else {
            return shift.hasLoaded ? "Смена закрыта" : "Касса"
        }
        let cash = Money.format(current.expectedCash)
        return placement == .inline ? "Смена · \(cash)" : "Смена открыта · \(cash) в кассе"
    }
}
