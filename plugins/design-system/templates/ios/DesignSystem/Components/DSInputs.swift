import SwiftUI

/// 1行の入力。一覧の行の中ではそのまま、一覧の外では bordered: true で枠を付ける。
/// message はエラーなどを入力欄の下に出す。id は入力欄そのものの accessibilityIdentifier。
struct DSTextField: View {
    private let placeholder: String
    @Binding private var text: String
    private let label: String?
    private let message: DSMessage?
    private let bordered: Bool
    private let id: String?
    private let onSubmit: () -> Void

    init(_ placeholder: String, text: Binding<String>, label: String? = nil, message: DSMessage? = nil, bordered: Bool = false, id: String? = nil, onSubmit: @escaping () -> Void = {}) {
        self.placeholder = placeholder
        self._text = text
        self.label = label
        self.message = message
        self.bordered = bordered
        self.id = id
        self.onSubmit = onSubmit
    }

    var body: some View {
        DSField(label: label, message: message, bordered: bordered) {
            TextField(placeholder, text: $text, prompt: Text(placeholder).foregroundStyle(DS.Color.textSecondary))
                .onSubmit(onSubmit)
                .dsIdentifier(id)
        }
    }
}

/// パスワードなど、伏せ字にする1行の入力。
struct DSSecureField: View {
    private let placeholder: String
    @Binding private var text: String
    private let label: String?
    private let message: DSMessage?
    private let bordered: Bool
    private let id: String?

    init(_ placeholder: String, text: Binding<String>, label: String? = nil, message: DSMessage? = nil, bordered: Bool = false, id: String? = nil) {
        self.placeholder = placeholder
        self._text = text
        self.label = label
        self.message = message
        self.bordered = bordered
        self.id = id
    }

    var body: some View {
        DSField(label: label, message: message, bordered: bordered) {
            SecureField(placeholder, text: $text, prompt: Text(placeholder).foregroundStyle(DS.Color.textSecondary))
                .dsIdentifier(id)
        }
    }
}

/// 複数行の入力。
struct DSTextEditor: View {
    private let placeholder: String
    @Binding private var text: String
    private let label: String?
    private let message: DSMessage?
    private let id: String?

    init(_ placeholder: String, text: Binding<String>, label: String? = nil, message: DSMessage? = nil, id: String? = nil) {
        self.placeholder = placeholder
        self._text = text
        self.label = label
        self.message = message
        self.id = id
    }

    var body: some View {
        DSField(label: label, message: message, bordered: true) {
            TextEditor(text: $text)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 96)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text(placeholder)
                            .foregroundStyle(DS.Color.textSecondary)
                            .padding(.top, DS.Space.space2)
                            .padding(.leading, DS.Space.space1)
                            .allowsHitTesting(false)
                    }
                }
                .dsIdentifier(id)
        }
    }
}

/// 入力欄に共通の、ラベル・枠・メッセージ。
private struct DSField<Input: View>: View {
    let label: String?
    let message: DSMessage?
    let bordered: Bool
    @ViewBuilder let input: Input

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.space1) {
            if let label {
                Text(label)
                    .font(DS.Font.caption)
                    .foregroundStyle(DS.Color.textSecondary)
            }
            input
                .font(DS.Font.body)
                .foregroundStyle(DS.Color.textPrimary)
                .tint(DS.Color.accent)
                .padding(.vertical, bordered ? DS.Space.space2 : 0)
                .padding(.horizontal, bordered ? DS.Space.space3 : 0)
                .background {
                    if bordered {
                        RoundedRectangle(cornerRadius: DS.Radius.radiusMd)
                            .fill(DS.Color.surface)
                        RoundedRectangle(cornerRadius: DS.Radius.radiusMd)
                            .strokeBorder(message?.kind == .error ? DS.Color.danger : DS.Color.border)
                    }
                }
            if let message {
                DSInlineMessage(message)
            }
        }
    }
}

/// オン・オフの切り替え（一覧の行）。
struct DSToggleRow: View {
    private let title: String
    private let subtitle: String?
    @Binding private var isOn: Bool

    init(_ title: String, subtitle: String? = nil, isOn: Binding<Bool>) {
        self.title = title
        self.subtitle = subtitle
        self._isOn = isOn
    }

    var body: some View {
        Toggle(isOn: $isOn) {
            DSRowText(title: title, subtitle: subtitle)
        }
        .tint(DS.Color.accent)
    }
}

/// 選択肢から1つ選ぶ（一覧の行）。
struct DSPickerRow<Value: Hashable>: View {
    private let title: String
    @Binding private var selection: Value
    private let options: [Value]
    private let label: (Value) -> String

    init(_ title: String, selection: Binding<Value>, options: [Value], label: @escaping (Value) -> String) {
        self.title = title
        self._selection = selection
        self.options = options
        self.label = label
    }

    var body: some View {
        Picker(selection: $selection) {
            ForEach(options, id: \.self) { option in
                Text(label(option)).tag(option)
            }
        } label: {
            Text(title)
                .font(DS.Font.body)
                .foregroundStyle(DS.Color.textPrimary)
        }
        .tint(DS.Color.textSecondary)
    }
}
