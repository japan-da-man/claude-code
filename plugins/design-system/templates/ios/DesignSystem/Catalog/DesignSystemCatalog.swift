import SwiftUI

extension View {
    /// DEBUG のときだけ、起動引数 `-DesignSystemCatalog <ページ>` で、この画面の代わりにデザインシステムのカタログを出す。
    /// アプリの入口（@main の WindowGroup の中の最初の画面）に付ける。ページを `index` にすると一覧から選べる。
    @ViewBuilder
    func designSystemCatalog() -> some View {
        #if DEBUG
        if let page = UserDefaults.standard.string(forKey: "DesignSystemCatalog") {
            DesignSystemCatalogView(page: page)
        } else {
            self
        }
        #else
        self
        #endif
    }
}

#if DEBUG
/// カタログ画面。1ページが1画面に収まるようにし、/design-system のスクリプトがページごとにスクリーンショットを撮る。
/// ページを足したら design-system/design-system.json の ios.catalog_pages にも足す。
struct DesignSystemCatalogView: View {
    static let pages: [(id: String, title: String)] = [
        ("colors", "色"),
        ("type", "文字"),
        ("spacing", "余白と角丸"),
        ("buttons", "ボタン"),
        ("inputs", "入力"),
        ("rows", "一覧"),
        ("messages", "メッセージ"),
        ("dialogs", "確認"),
        ("states", "状態"),
        ("patterns", "画面の型"),
    ]

    let page: String

    var body: some View {
        NavigationStack {
            Self.content(for: page)
        }
    }

    @ViewBuilder
    static func content(for page: String) -> some View {
        Group {
            switch page {
            case "colors": CatalogColors()
            case "type": CatalogType()
            case "spacing": CatalogSpacing()
            case "buttons": CatalogButtons()
            case "inputs": CatalogInputs()
            case "rows": CatalogRows()
            case "messages": CatalogMessages()
            case "dialogs": CatalogDialogs()
            case "states": CatalogStates()
            case "patterns": CatalogPatterns()
            default: CatalogIndex()
            }
        }
        .navigationTitle(pages.first { $0.id == page }?.title ?? "デザインシステム")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct CatalogIndex: View {
    var body: some View {
        List {
            ForEach(DesignSystemCatalogView.pages, id: \.id) { page in
                NavigationLink {
                    DesignSystemCatalogView.content(for: page.id)
                } label: {
                    DSRow(page.title, subtitle: page.id)
                }
            }
            .dsRowBackground()
        }
        .dsListStyle()
    }
}

/// スクロールしないページの台紙。
private struct CatalogPage<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.space4) {
            content
        }
        .padding(DS.Space.space4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(DS.Color.background)
    }
}

private struct CatalogLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(DS.Font.caption)
            .foregroundStyle(DS.Color.textSecondary)
    }
}

private struct CatalogColors: View {
    var body: some View {
        CatalogPage {
            ForEach(DS.Color.all.indices, id: \.self) { i in
                let token = DS.Color.all[i]
                HStack(spacing: DS.Space.space3) {
                    RoundedRectangle(cornerRadius: DS.Radius.radiusSm)
                        .fill(token.color)
                        .frame(width: 40, height: 28)
                        .overlay(RoundedRectangle(cornerRadius: DS.Radius.radiusSm).strokeBorder(DS.Color.border))
                    DSRowText(title: token.name, subtitle: token.usage)
                        .lineLimit(1)
                }
            }
        }
    }
}

private struct CatalogType: View {
    var body: some View {
        List {
            ForEach(DS.Font.all.indices, id: \.self) { i in
                let token = DS.Font.all[i]
                VStack(alignment: .leading, spacing: DS.Space.space1) {
                    Text("あいうえお Aa 123")
                        .font(token.font)
                        .foregroundStyle(DS.Color.textPrimary)
                    CatalogLabel(text: "\(token.name)　\(token.usage)")
                }
            }
            .dsRowBackground()
        }
        .dsListStyle()
    }
}

private struct CatalogSpacing: View {
    var body: some View {
        CatalogPage {
            CatalogLabel(text: "余白")
            ForEach(DS.Space.all.indices, id: \.self) { i in
                let token = DS.Space.all[i]
                HStack(spacing: DS.Space.space3) {
                    Text(token.name)
                        .font(DS.Font.callout)
                        .foregroundStyle(DS.Color.textPrimary)
                        .frame(width: 80, alignment: .leading)
                    Rectangle()
                        .fill(DS.Color.accent)
                        .frame(width: token.value, height: 12)
                    Text("\(Int(token.value))")
                        .font(DS.Font.caption)
                        .foregroundStyle(DS.Color.textSecondary)
                }
            }
            CatalogLabel(text: "角丸")
            HStack(spacing: DS.Space.space4) {
                ForEach(DS.Radius.all.indices, id: \.self) { i in
                    let token = DS.Radius.all[i]
                    VStack(spacing: DS.Space.space1) {
                        RoundedRectangle(cornerRadius: token.value)
                            .fill(DS.Color.surface)
                            .overlay(RoundedRectangle(cornerRadius: token.value).strokeBorder(DS.Color.accent))
                            .frame(width: 72, height: 56)
                        CatalogLabel(text: "\(token.name) \(Int(token.value))")
                    }
                }
            }
        }
    }
}

private struct CatalogButtons: View {
    var body: some View {
        CatalogPage {
            CatalogLabel(text: "種類")
            HStack(spacing: DS.Space.space2) {
                DSButton("保存", kind: .primary) {}
                DSButton("キャンセル", kind: .secondary) {}
            }
            HStack(spacing: DS.Space.space2) {
                DSButton("削除", kind: .destructive) {}
                DSButton("あとで", kind: .plain) {}
            }
            CatalogLabel(text: "状態")
            HStack(spacing: DS.Space.space2) {
                DSButton("保存", kind: .primary) {}
                    .disabled(true)
                DSButton("保存中", kind: .primary, isLoading: true) {}
            }
            CatalogLabel(text: "アイコンつき・幅いっぱい")
            DSButton("追加", systemImage: "plus", kind: .primary, fullWidth: true) {}
            CatalogLabel(text: "アイコンだけ")
            HStack(spacing: DS.Space.space2) {
                DSIconButton("追加", systemImage: "plus") {}
                DSIconButton("共有", systemImage: "square.and.arrow.up") {}
                DSIconButton("削除", systemImage: "trash", kind: .destructive) {}
            }
        }
    }
}

private struct CatalogInputs: View {
    @State private var empty = ""
    @State private var filled = "牛乳を買う"
    @State private var invalid = "   "
    @State private var password = "secret"
    @State private var note = ""
    @State private var isOn = true
    @State private var choice = "新しい順"

    var body: some View {
        List {
            Section {
                DSTextField("メモを入力", text: $empty)
                DSTextField("メモを入力", text: $filled)
                DSTextField("メモを入力", text: $invalid, message: .error("メモを入力してください"))
            } header: {
                DSSectionHeader("一覧の中")
            }
            .dsRowBackground()
            Section {
                DSToggleRow("通知", subtitle: "毎朝 9 時に知らせる", isOn: $isOn)
                DSPickerRow("並び順", selection: $choice, options: ["新しい順", "古い順"]) { $0 }
            }
            .dsRowBackground()
            Section {
                VStack(spacing: DS.Space.space3) {
                    DSTextField("名前", text: $empty, label: "名前", bordered: true)
                    DSSecureField("パスワード", text: $password, label: "パスワード", bordered: true)
                    DSTextEditor("詳しい内容", text: $note, label: "本文")
                }
                .listRowBackground(Color.clear)
            } header: {
                DSSectionHeader("一覧の外（枠つき）")
            }
        }
        .dsListStyle()
    }
}

private struct CatalogRows: View {
    var body: some View {
        List {
            Section {
                DSRow("牛乳を買う")
                DSRow("打ち合わせ", subtitle: "10 月 20 日 14:00")
                DSRow("並び順", systemImage: "arrow.up.arrow.down", value: "新しい順", accessory: .chevron)
                HStack {
                    DSRow("未読", systemImage: "envelope")
                    DSBadge("3", kind: .accent)
                }
            } header: {
                DSSectionHeader("見出し", detail: "4 件")
            }
            .dsRowBackground()
            Section {
                HStack(spacing: DS.Space.space2) {
                    DSBadge("下書き")
                    DSBadge("新着", kind: .accent)
                    DSBadge("期限切れ", kind: .danger)
                    DSBadge("完了", kind: .success)
                    DSBadge("注意", kind: .warning)
                }
                .listRowBackground(Color.clear)
                DSCard {
                    Text("カード")
                        .font(DS.Font.headline)
                        .foregroundStyle(DS.Color.textPrimary)
                    Text("一覧の外で、まとまりを囲むときに使う")
                        .font(DS.Font.callout)
                        .foregroundStyle(DS.Color.textSecondary)
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            } header: {
                DSSectionHeader("印とカード")
            }
        }
        .dsListStyle()
    }
}

private struct CatalogMessages: View {
    var body: some View {
        CatalogPage {
            CatalogLabel(text: "入力欄の下")
            DSInlineMessage(.error("メモを入力してください"))
            DSInlineMessage(.warning("あと 3 文字で上限です"))
            DSInlineMessage(.success("保存しました"))
            DSInlineMessage(.info("30 文字まで入力できます"))
            CatalogLabel(text: "画面の上")
            DSBanner(.error("インターネットに接続できません"), actionTitle: "再試行") {}
            DSBanner(.info("新しいバージョンがあります"))
            CatalogLabel(text: "消える知らせ（下）")
        }
        .dsToast(.constant(.success("保存しました")))
    }
}

private struct CatalogDialogs: View {
    @State private var confirming = false

    var body: some View {
        CatalogPage {
            CatalogLabel(text: "取り消せない操作の前の確認")
            DSButton("削除", kind: .destructive) { confirming = true }
        }
        .dsConfirm("このメモを削除しますか？", isPresented: $confirming, actionTitle: "削除", message: "削除すると元に戻せません") {}
        .task {
            // スクリーンショットに確認が写るよう、開いたらすぐに出す（画面が出る前だと出ないので少し待つ）
            try? await Task.sleep(for: .milliseconds(500))
            confirming = true
        }
    }
}

private struct CatalogStates: View {
    var body: some View {
        CatalogPage {
            CatalogLabel(text: "空の状態（画面いっぱい）")
            DSEmptyState("メモはまだありません", systemImage: "note.text", message: "思いついたことを書き留めましょう", actionTitle: "メモを追加") {}
            CatalogLabel(text: "空の状態（一覧の中）")
            DSEmptyState("メモはまだありません")
            CatalogLabel(text: "読み込み中")
            DSLoading("読み込み中")
        }
    }
}

/// 一覧画面の型の例（design-system/patterns.md）。アプリの画面に合わせて直す。
private struct CatalogPatterns: View {
    @State private var draft = ""

    var body: some View {
        List {
            Section {
                HStack(spacing: DS.Space.space2) {
                    DSTextField("メモを入力", text: $draft)
                    DSButton("追加", kind: .primary) {}
                }
            }
            .dsRowBackground()
            Section {
                DSRow("牛乳を買う")
                DSRow("打ち合わせの資料を送る")
            } header: {
                DSSectionHeader("2 件")
            }
            .dsRowBackground()
        }
        .dsListStyle()
        .navigationTitle("一覧画面")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                DSIconButton("並び替え", systemImage: "arrow.up.arrow.down") {}
            }
        }
    }
}
#endif
