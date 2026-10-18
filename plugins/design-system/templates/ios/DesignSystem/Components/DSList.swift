import SwiftUI

/// 一覧の行。タイトルと補足、先頭のアイコン、末尾の値や矢印。
/// NavigationLink の中に置くときは、矢印は NavigationLink が付けるので accessory は .none のままにする。
struct DSRow: View {
    enum Accessory {
        case none, chevron
    }

    private let title: String
    private let subtitle: String?
    private let systemImage: String?
    private let value: String?
    private let accessory: Accessory

    init(_ title: String, subtitle: String? = nil, systemImage: String? = nil, value: String? = nil, accessory: Accessory = .none) {
        self.title = title
        self.subtitle = subtitle
        self.systemImage = systemImage
        self.value = value
        self.accessory = accessory
    }

    var body: some View {
        HStack(spacing: DS.Space.space3) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(DS.Font.body)
                    .foregroundStyle(DS.Color.accent)
                    .frame(width: 28)
            }
            DSRowText(title: title, subtitle: subtitle)
            Spacer(minLength: DS.Space.space2)
            if let value {
                Text(value)
                    .font(DS.Font.body)
                    .foregroundStyle(DS.Color.textSecondary)
            }
            if accessory == .chevron {
                Image(systemName: "chevron.right")
                    .font(DS.Font.caption)
                    .foregroundStyle(DS.Color.textSecondary)
            }
        }
        .padding(.vertical, DS.Space.space1)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// 行の中のタイトルと補足。DSRow・DSToggleRow が使う。
struct DSRowText: View {
    let title: String
    let subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.space1) {
            Text(title)
                .font(DS.Font.body)
                .foregroundStyle(DS.Color.textPrimary)
            if let subtitle {
                Text(subtitle)
                    .font(DS.Font.caption)
                    .foregroundStyle(DS.Color.textSecondary)
            }
        }
    }
}

/// 一覧の見出し。detail に件数などの補足を出す。
struct DSSectionHeader: View {
    private let title: String
    private let detail: String?

    init(_ title: String, detail: String? = nil) {
        self.title = title
        self.detail = detail
    }

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            if let detail {
                Text(detail)
            }
        }
        .font(DS.Font.caption)
        .foregroundStyle(DS.Color.textSecondary)
        .textCase(nil)
        .accessibilityElement(children: .combine)
    }
}

/// 件数や状態の小さな印。
struct DSBadge: View {
    enum Kind {
        case neutral, accent, danger, success, warning
    }

    private let text: String
    private let kind: Kind

    init(_ text: String, kind: Kind = .neutral) {
        self.text = text
        self.kind = kind
    }

    var body: some View {
        Text(text)
            .font(DS.Font.caption)
            .foregroundStyle(color)
            .padding(.vertical, DS.Space.space1 / 2)
            .padding(.horizontal, DS.Space.space2)
            .background(color.opacity(0.14), in: RoundedRectangle(cornerRadius: DS.Radius.radiusSm))
    }

    private var color: Color {
        switch kind {
        case .neutral: DS.Color.textSecondary
        case .accent: DS.Color.accent
        case .danger: DS.Color.danger
        case .success: DS.Color.success
        case .warning: DS.Color.warning
        }
    }
}

/// 一覧の外で、まとまりを囲む。
struct DSCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.space2) {
            content
        }
        .padding(DS.Space.space4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DS.Color.surface, in: RoundedRectangle(cornerRadius: DS.Radius.radiusLg))
    }
}

extension View {
    /// 一覧の画面の背景をデザインシステムの色にする。List に付ける。
    func dsListStyle() -> some View {
        listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(DS.Color.background)
    }

    /// 一覧の行の背景をデザインシステムの色にする。行（か Section の中身）に付ける。
    func dsRowBackground() -> some View {
        listRowBackground(DS.Color.surface)
    }
}
