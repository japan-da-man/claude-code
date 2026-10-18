import SwiftUI

/// 空の状態。何がないかと、最初にすることを伝える。id は見出しの accessibilityIdentifier。
struct DSEmptyState: View {
    private let systemImage: String?
    private let title: String
    private let message: String?
    private let actionTitle: String?
    private let action: (() -> Void)?
    private let id: String?

    init(_ title: String, systemImage: String? = nil, message: String? = nil, actionTitle: String? = nil, id: String? = nil, action: (() -> Void)? = nil) {
        self.title = title
        self.systemImage = systemImage
        self.message = message
        self.actionTitle = actionTitle
        self.action = action
        self.id = id
    }

    var body: some View {
        VStack(spacing: DS.Space.space3) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(DS.Font.title)
                    .foregroundStyle(DS.Color.textSecondary)
            }
            Text(title)
                .font(systemImage == nil ? DS.Font.body : DS.Font.headline)
                .foregroundStyle(systemImage == nil ? DS.Color.textSecondary : DS.Color.textPrimary)
                .dsIdentifier(id)
            if let message {
                Text(message)
                    .font(DS.Font.callout)
                    .foregroundStyle(DS.Color.textSecondary)
            }
            if let actionTitle, let action {
                DSButton(actionTitle, kind: .secondary, action: action)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.vertical, systemImage == nil ? DS.Space.space2 : DS.Space.space6)
    }
}

/// 読み込み中。
struct DSLoading: View {
    private let label: String?

    init(_ label: String? = nil) {
        self.label = label
    }

    var body: some View {
        VStack(spacing: DS.Space.space2) {
            ProgressView()
                .tint(DS.Color.accent)
            if let label {
                Text(label)
                    .font(DS.Font.caption)
                    .foregroundStyle(DS.Color.textSecondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, DS.Space.space5)
    }
}
