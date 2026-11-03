import SwiftUI

/// «Онлайн-запись»: how clients book themselves on the booking page, in the Mini App and through the bot, and — on a
/// server that knows it — when a booking nobody confirmed is rejected by itself.
struct OnlineBookingSection: View {
    @Binding var settings: OnlineBookingSettings

    var body: some View {
        rulesSection
        if let autoReject = Binding($settings.autoReject) {
            autoRejectSection(autoReject)
        }
    }

    private var rulesSection: some View {
        Section {
            Toggle("Онлайн-запись", isOn: $settings.enabled)
            Group {
                Picker("Не позже чем за", selection: $settings.leadMinutes) {
                    ForEach(OnlineBookingOptions.leads(including: settings.leadMinutes), id: \.self) { minutes in
                        Text(OnlineBookingOptions.leadTitle(minutes)).tag(minutes)
                    }
                }
                Picker("Запись вперёд на", selection: $settings.horizonDays) {
                    ForEach(OnlineBookingOptions.horizons(including: settings.horizonDays), id: \.self) { days in
                        Text(OnlineBookingOptions.horizonTitle(days)).tag(days)
                    }
                }
                Picker("Время на оплату", selection: $settings.holdMinutes) {
                    ForEach(OnlineBookingOptions.holds(including: settings.holdMinutes), id: \.self) { minutes in
                        Text(OnlineBookingOptions.minutesTitle(minutes)).tag(minutes)
                    }
                }
                Picker("Шаг времени", selection: $settings.stepMinutes) {
                    ForEach(OnlineBookingOptions.steps(including: settings.stepMinutes), id: \.self) { minutes in
                        Text(OnlineBookingOptions.minutesTitle(minutes)).tag(minutes)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Заметка для клиентов")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField("Например: возьмите с собой паспорт", text: $settings.note, axis: .vertical)
                        .lineLimit(2...6)
                }
                .accessibilityElement(children: .combine)
            }
            .disabled(!settings.enabled)
        } header: {
            Text("Онлайн-запись")
        } footer: {
            if let issue = OnlineBookingRules.issue(settings) {
                Text(issue).foregroundStyle(.red)
            } else {
                Text(OnlineBookingOptions.footer(settings))
            }
        }
        .monospacedDigit()
    }

    /// Applies to bookings already waiting too, so it stays on while online booking is off.
    private func autoRejectSection(_ autoReject: Binding<OnlineAutoReject>) -> some View {
        Section {
            Picker("Автоотмена неподтверждённых онлайн-записей", selection: autoReject) {
                ForEach(OnlineBookingOptions.autoRejects(including: autoReject.wrappedValue), id: \.self) { value in
                    Text(OnlineBookingOptions.autoRejectTitle(value)).tag(value)
                }
            }
        } footer: {
            Text(OnlineBookingOptions.autoRejectFooter(autoReject.wrappedValue))
        }
        .monospacedDigit()
    }
}

/// «Ссылка для записи» under the online booking settings: open to every role, even where the settings are read-only.
struct BookingLinkSection: View {
    @Environment(APIClient.self) private var api
    let isEnabled: Bool

    var body: some View {
        Section {
            NavigationLink {
                BookingLinkView(isEnabled: isEnabled)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Label("Ссылка для записи", systemImage: "link")
                    Text(BookingLink.url(server: api.serverURL).absoluteString)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
        } footer: {
            Text("Ссылка, QR-код и куда их поставить: шапка Instagram, Яндекс Карты, 2ГИС.")
        }
    }
}

#if DEBUG
#Preview {
    @Previewable @State var settings = OnlineBookingSettings(autoReject: .standard)
    NavigationStack {
        Form {
            OnlineBookingSection(settings: $settings)
            BookingLinkSection(isEnabled: settings.enabled)
        }
    }
    .previewEnvironment()
}
#endif
