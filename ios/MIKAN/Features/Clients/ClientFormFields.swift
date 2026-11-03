import SwiftUI

/// "@" + text field for a username (Telegram nick, Instagram).
struct ClientHandleField: View {
    let title: String
    @Binding var text: String

    var body: some View {
        HStack(spacing: 4) {
            Text("@").foregroundStyle(.secondary)
            TextField(title, text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel(title)
        }
    }
}

/// «Указать дату рождения» and the date itself once switched on; «Без года» picks only the day and the month.
struct ClientBirthdayFields: View {
    @Binding var draft: ClientDraft

    var body: some View {
        Toggle("Указать дату рождения", isOn: $draft.hasBirthday.animation())
        if draft.hasBirthday {
            Toggle("Без года", isOn: $draft.birthdayWithoutYear.animation())
            if draft.birthdayWithoutYear {
                Picker("День", selection: $draft.birthdayDay) {
                    ForEach(1...Birthday.daysIn(month: draft.birthdayMonth, year: nil), id: \.self) { day in
                        Text("\(day)").tag(day)
                    }
                }
                Picker("Месяц", selection: $draft.birthdayMonth) {
                    ForEach(1...12, id: \.self) { month in
                        Text(Birthday.monthName(month)).tag(month)
                    }
                }
            } else {
                DatePicker("Дата рождения", selection: $draft.birthday, in: ...Date.now, displayedComponents: .date)
            }
        }
    }
}
