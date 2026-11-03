import SwiftUI

/// «Зарплата» in the employee card: opens the pay rules. Shown to the owner only.
struct PayRulesSection: View {
    @Environment(AppState.self) private var appState

    let employee: Employee

    var body: some View {
        if appState.employee?.role == .owner {
            Section {
                NavigationLink {
                    PayRulesView(employee: employee.ref)
                } label: {
                    Label("Правила зарплаты", systemImage: "banknote")
                }
            } footer: {
                Text("Оклад, оплата за рабочий день и проценты с услуг и товаров.")
            }
        }
    }
}
