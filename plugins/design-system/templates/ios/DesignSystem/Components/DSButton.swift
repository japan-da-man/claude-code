import SwiftUI

/// ボタン。画面の主な操作は primary、それ以外は secondary、取り消せない操作は destructive、目立たせない操作は plain。
struct DSButton: View {
    enum Kind {
        case primary, secondary, destructive, plain
    }

    private let title: String
    private let systemImage: String?
    private let kind: Kind
    private let isLoading: Bool
    private let fullWidth: Bool
    private let action: () -> Void

    init(_ title: String, systemImage: String? = nil, kind: Kind = .primary, isLoading: Bool = false, fullWidth: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.systemImage = systemImage
        self.kind = kind
        self.isLoading = isLoading
        self.fullWidth = fullWidth
        self.action = action
    }

    var body: some View {
        Button(role: kind == .destructive ? .destructive : nil, action: action) {
            HStack(spacing: DS.Space.space2) {
                if isLoading {
                    ProgressView()
                } else if let systemImage {
                    Image(systemName: systemImage)
                }
                Text(title)
            }
            .frame(maxWidth: fullWidth ? .infinity : nil)
        }
        .buttonStyle(DSButtonStyle(kind: kind))
        .disabled(isLoading)
    }
}

/// DSButton の見た目。DSButton を使えないところ（Menu の中など）でだけ、Button に直接付ける。
struct DSButtonStyle: ButtonStyle {
    let kind: DSButton.Kind
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(DS.Font.headline)
            .foregroundStyle(foreground)
            .tint(foreground)
            .padding(.vertical, kind == .plain ? DS.Space.space1 : DS.Space.space3)
            .padding(.horizontal, kind == .plain ? 0 : DS.Space.space4)
            .frame(minHeight: 44)
            .background(background, in: RoundedRectangle(cornerRadius: DS.Radius.radiusMd))
            .overlay {
                if kind == .secondary {
                    RoundedRectangle(cornerRadius: DS.Radius.radiusMd).strokeBorder(DS.Color.border)
                }
            }
            .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
            .contentShape(Rectangle())
    }

    private var foreground: Color {
        switch kind {
        case .primary: DS.Color.textOnAccent
        case .secondary, .plain: DS.Color.accent
        case .destructive: DS.Color.danger
        }
    }

    private var background: Color {
        switch kind {
        case .primary: DS.Color.accent
        case .secondary: DS.Color.surface
        case .plain: Color.clear
        case .destructive: DS.Color.danger.opacity(0.12)
        }
    }
}

/// アイコンだけのボタン（ツールバーなど）。読み上げ用の label は必ず渡す。
struct DSIconButton: View {
    private let systemImage: String
    private let label: String
    private let kind: DSButton.Kind
    private let action: () -> Void

    init(_ label: String, systemImage: String, kind: DSButton.Kind = .plain, action: @escaping () -> Void) {
        self.label = label
        self.systemImage = systemImage
        self.kind = kind
        self.action = action
    }

    var body: some View {
        Button(role: kind == .destructive ? .destructive : nil, action: action) {
            Image(systemName: systemImage)
                .font(DS.Font.headline)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(kind == .destructive ? DS.Color.danger : DS.Color.accent)
        .accessibilityLabel(label)
    }
}
