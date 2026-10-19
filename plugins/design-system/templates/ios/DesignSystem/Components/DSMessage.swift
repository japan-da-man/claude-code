import SwiftUI

/// 利用者に知らせるメッセージ。入力欄の下（DSInlineMessage）、画面の上（DSBanner）、消える知らせ（.dsToast）で同じものを使う。
/// 言い方は design-system/copy.md に従う。
struct DSMessage: Equatable {
    enum Kind {
        case error, warning, success, info
    }

    var text: String
    var kind: Kind
    /// UI テストやシミュレーターの操作で見つけるための識別子（accessibilityIdentifier）。
    var id: String?

    static func error(_ text: String, id: String? = nil) -> DSMessage { DSMessage(text: text, kind: .error, id: id) }
    static func warning(_ text: String, id: String? = nil) -> DSMessage { DSMessage(text: text, kind: .warning, id: id) }
    static func success(_ text: String, id: String? = nil) -> DSMessage { DSMessage(text: text, kind: .success, id: id) }
    static func info(_ text: String, id: String? = nil) -> DSMessage { DSMessage(text: text, kind: .info, id: id) }

    var color: Color {
        switch kind {
        case .error: DS.Color.danger
        case .warning: DS.Color.warning
        case .success: DS.Color.success
        case .info: DS.Color.info
        }
    }

    var systemImage: String {
        switch kind {
        case .error: "exclamationmark.circle.fill"
        case .warning: "exclamationmark.triangle.fill"
        case .success: "checkmark.circle.fill"
        case .info: "info.circle.fill"
        }
    }
}

/// 入力欄の下に出す短いメッセージ。
struct DSInlineMessage: View {
    private let message: DSMessage

    init(_ message: DSMessage) {
        self.message = message
    }

    var body: some View {
        Label {
            Text(message.text)
        } icon: {
            Image(systemName: message.systemImage)
        }
        .font(DS.Font.caption)
        .foregroundStyle(message.color)
        .accessibilityElement(children: .combine)
        .dsIdentifier(message.id)
    }
}

/// 画面の上に出す、画面全体に関わるメッセージ（通信できない、など）。やり直しなどの操作を1つ付けられる。
struct DSBanner: View {
    private let message: DSMessage
    private let actionTitle: String?
    private let action: (() -> Void)?

    init(_ message: DSMessage, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        self.message = message
        self.actionTitle = actionTitle
        self.action = action
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: DS.Space.space2) {
            Image(systemName: message.systemImage)
                .foregroundStyle(message.color)
            Text(message.text)
                .foregroundStyle(DS.Color.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .dsIdentifier(message.id)
            if let actionTitle, let action {
                DSButton(actionTitle, kind: .plain, action: action)
            }
        }
        .font(DS.Font.callout)
        .padding(.vertical, DS.Space.space3)
        .padding(.horizontal, DS.Space.space4)
        .background(message.color.opacity(0.12), in: RoundedRectangle(cornerRadius: DS.Radius.radiusLg))
    }
}

extension View {
    /// 操作の結果を短く知らせて、しばらくすると消える（「保存しました」）。message を入れると出て、消えると nil に戻る。
    func dsToast(_ message: Binding<DSMessage?>, seconds: Double = 2) -> some View {
        overlay(alignment: .bottom) {
            if let current = message.wrappedValue {
                Label {
                    Text(current.text)
                } icon: {
                    Image(systemName: current.systemImage)
                }
                .font(DS.Font.callout)
                .foregroundStyle(DS.Color.textOnAccent)
                .padding(.vertical, DS.Space.space3)
                .padding(.horizontal, DS.Space.space4)
                .background(DS.Color.textPrimary.opacity(0.88), in: Capsule())
                .padding(.bottom, DS.Space.space5)
                .accessibilityElement(children: .combine)
                .dsIdentifier(current.id)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task(id: current) {
                    try? await Task.sleep(for: .seconds(seconds))
                    withAnimation { message.wrappedValue = nil }
                }
            }
        }
        .animation(.default, value: message.wrappedValue)
    }

    /// 続けられないエラーを知らせる。content を入れると出て、閉じると nil に戻る。
    func dsAlert(_ content: Binding<DSAlertContent?>, buttonTitle: String = "OK") -> some View {
        alert(
            content.wrappedValue?.title ?? "",
            isPresented: Binding(get: { content.wrappedValue != nil }, set: { if !$0 { content.wrappedValue = nil } }),
            presenting: content.wrappedValue
        ) { _ in
            Button(buttonTitle, role: .cancel) {}
        } message: { value in
            Text(value.message)
        }
    }

    /// 取り消せない操作（削除など）の前の確認。「キャンセル」と、赤い実行のボタンをいつも並べる。
    /// HIG では、破壊的な結果の確認にはアラートが合う（選択肢が複数あるときのアクションシートは別の部品にする）。
    /// iOS 26 の confirmationDialog はポップオーバーになり「キャンセル」が見えなくなるので使わない。
    func dsConfirm(_ title: String, isPresented: Binding<Bool>, actionTitle: String, message: String? = nil, cancelTitle: String = "キャンセル", action: @escaping () -> Void) -> some View {
        alert(title, isPresented: isPresented) {
            Button(cancelTitle, role: .cancel) {}
            Button(actionTitle, role: .destructive, action: action)
        } message: {
            if let message {
                Text(message)
            }
        }
    }
}

/// .dsAlert に渡す中身。
struct DSAlertContent: Equatable {
    var title: String
    var message: String
}

extension View {
    /// id があるときだけ accessibilityIdentifier を付ける（factory の検証役や UI テストが画面の要素を見つけるのに使う）。
    @ViewBuilder
    func dsIdentifier(_ id: String?) -> some View {
        if let id {
            accessibilityIdentifier(id)
        } else {
            self
        }
    }
}
