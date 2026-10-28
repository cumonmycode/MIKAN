import SwiftUI

/// «Скидка» of the receipt: an amount, a quick percent of the lines it may cover (never a gift certificate sold), the
/// client's birthday discount, «Без скидки».
struct ReceiptDiscountSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(CartStore.self) private var cart

    var body: some View {
        @Bindable var cart = cart
        NavigationStack {
            Form {
                Section {
                    NumberField.money("Скидка", value: $cart.discount, systemImage: "tag")
                    percentChips
                } footer: {
                    if !cart.isDiscountValid {
                        Text("Скидка не может быть больше \(Money.format(cart.discountableSubtotal)).")
                            .foregroundStyle(.red)
                    } else if cart.sellsCertificate {
                        Text("На подарочный сертификат скидка не действует.")
                    }
                }
                if let birthday = cart.birthdayDiscount, cart.birthdayDiscountAmount > 0 {
                    Section {
                        Button {
                            cart.applyBirthdayDiscount()
                            dismiss()
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("🎂 Скидка именинника \(birthday.percent)%")
                                    Text(ReceiptDiscountText.birthday(amount: cart.birthdayDiscountAmount, discount: birthday))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .monospacedDigit()
                                }
                                Spacer(minLength: 8)
                                if cart.isBirthdayDiscountApplied {
                                    Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                                }
                            }
                            .frame(minHeight: 44)
                            .contentShape(.rect)
                        }
                        .tint(.primary)
                    }
                }
                if cart.discount > 0 {
                    Section {
                        Button("Без скидки", role: .destructive) {
                            cart.discount = 0
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle("Скидка")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Готово") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var percentChips: some View {
        HStack(spacing: 8) {
            ForEach(ReceiptDiscountText.percents, id: \.self) { percent in
                let amount = ReceiptDiscountText.amount(percent: percent, base: cart.discountableSubtotal)
                Button {
                    cart.discount = amount
                } label: {
                    Text("\(percent)%")
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .tint(cart.discount == amount && amount > 0 ? Color.accentColor : Color.secondary)
                .disabled(amount == 0)
                .accessibilityLabel("Скидка \(percent)%: \(Money.format(amount))")
            }
        }
        .sensoryFeedback(.selection, trigger: cart.discount)
    }
}

/// Quick discounts of the receipt.
nonisolated enum ReceiptDiscountText {
    static let percents = [5, 10, 15, 20]

    /// `floor(base × percent / 100)` — the same rounding as the birthday discount.
    static func amount(percent: Int, base: Int) -> Int {
        CheckoutCredits.birthdayDiscount(base: base, percent: percent)
    }

    /// «−350 ₽ · действует до 25 октября».
    static func birthday(amount: Int, discount: BirthdayDiscount) -> String {
        let text = "−\(Money.format(amount))"
        guard let until = CalendarDay.date(from: discount.until) else { return text }
        return "\(text) · действует до \(DateText.dayMonth(until))"
    }
}
