# 部品

すべての部品は `<アプリ>/DesignSystem/Components/` にある。見た目はカタログ画面（スクリーンショットは [screenshots/](screenshots)）で確かめる。

**識別子（accessibilityIdentifier）**: 1つの要素でできた部品（`DSButton`・`DSRow`・`DSSectionHeader` など）には、ふつうに `.accessibilityIdentifier("…")` を付ける。入力欄と空の状態は、中の要素に付けるため `id:` で渡す。メッセージは `DSMessage` の `id` に入れる。

## ボタン

### DSButton

```swift
DSButton("保存", kind: .primary) { save() }
DSButton("削除", systemImage: "trash", kind: .destructive) { confirming = true }
DSButton("保存中", isLoading: true) {}
DSButton("始める", fullWidth: true) { start() }
```

| 種類 | いつ使う |
| :- | :- |
| `primary` | 画面でいちばん主な操作。1画面に1つまで |
| `secondary` | 主な操作と並ぶ、それ以外の操作 |
| `destructive` | 削除など取り消せない操作。押したら `.dsConfirm` で確かめる |
| `plain` | 目立たせない操作（あとで、詳しく見る、など） |

- 押せないときは `.disabled(true)`、処理中は `isLoading: true`（押せなくなる）。
- 一覧の行の中でも使える（行全体が押されることはない）。

### DSIconButton

```swift
DSIconButton("並び替え", systemImage: "arrow.up.arrow.down") { … }
```

アイコンだけのボタン（ツールバーなど）。読み上げ用のラベル（最初の引数）は必ず渡す。

## 入力

### DSTextField・DSSecureField

```swift
DSTextField("メモを入力", text: $draft, message: error, id: "memo-input", onSubmit: add)
DSTextField("名前", text: $name, label: "名前", bordered: true)
DSSecureField("パスワード", text: $password, label: "パスワード", bordered: true)
```

- 一覧の行の中ではそのまま、一覧の外では `bordered: true` で枠を付ける。
- `message` にエラーを入れると、入力欄の下に出る（枠があれば枠も赤くなる）。言い方は [copy.md](copy.md)。

### DSTextEditor

複数行の入力。常に枠つき。`DSTextEditor("詳しい内容", text: $note, label: "本文")`

### DSToggleRow・DSPickerRow

```swift
DSToggleRow("通知", subtitle: "毎朝 9 時に知らせる", isOn: $notify)
DSPickerRow("並び順", selection: $order, options: Order.allCases) { $0.label }
```

## 一覧

- 一覧の画面の `List` には `.dsListStyle()`、各 `Section` の中身には `.dsRowBackground()` を付ける。
- `DSRow("タイトル", subtitle: "補足", systemImage: "gear", value: "オン", accessory: .chevron)`。`NavigationLink` の中では矢印が自動で付くので `accessory` は付けない。
- `DSSectionHeader("見出し", detail: "3 件")` を `Section` の `header:` に置く。

## メッセージ

中身はどれも `DSMessage`（`.error`・`.warning`・`.success`・`.info`）。言い方は [copy.md](copy.md)。

| 部品 | いつ使う |
| :- | :- |
| `DSInlineMessage(.error("…"))` | 入力欄の下。その入力についての短い知らせ（入力欄の `message:` でも出せる） |
| `DSBanner(.error("…"), actionTitle: "再試行") { … }` | 画面の上。画面全体に関わる知らせ（通信できない、など） |
| `.dsToast($toast)` | 操作の結果を短く知らせて消える（「保存しました」）。`toast = .success("保存しました")` で出す |
| `.dsAlert($alert)` | 続けられないエラー。`alert = DSAlertContent(title: "…", message: "…")` で出す |
| `.dsConfirm("…しますか？", isPresented: $confirming, actionTitle: "削除") { … }` | 取り消せない操作の前の確認。アラートで「キャンセル」と赤い実行のボタンを並べる（HIG：破壊的な結果の確認にはアラート） |

## 状態

- `DSEmptyState("メモはまだありません", id: "memo-empty")`: 一覧の中の空の状態（アイコンなし）。
- `DSEmptyState("メモはまだありません", systemImage: "note.text", message: "…", actionTitle: "メモを追加") { … }`: 画面いっぱいの空の状態。
- `DSLoading("読み込み中")`: 読み込み中。

## その他

- `DSBadge("3", kind: .accent)`: 件数や状態の小さな印（`neutral`・`accent`・`danger`・`success`・`warning`）。
- `DSCard { … }`: 一覧の外で、まとまりを囲む。
