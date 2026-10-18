# 画面の型

新しい画面は、ここにある型のどれかに合わせて作る。どの型にも合わないときは、いちばん近い型をもとにして、PR のレポートなどに「型の候補」として書く（型を足すかは、人が `/design-system:update` で決める）。

<!-- init の一問一答で、今のアプリの画面を読み取って型にする。決まったら、このコメントを消す -->

## 一覧画面

項目を並べて、追加・削除・開くをする画面。

- `NavigationStack` の中の `List`。`.dsListStyle()` を付ける。
- 画面の名前は `.navigationTitle`（大きい見出し）。
- 追加の入力が短いときは、一覧の最初の `Section` に `DSTextField` と `DSButton`（primary）を並べる。長いときは、ツールバーの `DSIconButton("追加", systemImage: "plus")` から編集画面を開く。
- 項目は `DSRow`。見出しは `DSSectionHeader`（件数を出すときは見出しに出す）。
- 空のときは、一覧の中に `DSEmptyState`（アイコンなし）を出す。
- 削除はスワイプ（`.onDelete`）。取り消せない一括の削除は `.dsConfirm` で確かめる。

## 編集画面

1つの項目の中身を入力して保存する画面。

- `NavigationStack` の中の `List`（`.dsListStyle()`）か、一覧の外の `DSCard` の並び。
- 画面の名前は `.navigationTitle` で、`.navigationBarTitleDisplayMode(.inline)`。
- ツールバーの左に「キャンセル」、右に「保存」（`DSButton` の `plain`）。保存できない間は「保存」を押せなくする。
- 入力のエラーは、保存を押したときに、その入力欄の下に出す（`message:`）。
- 保存したら画面を閉じ、前の画面で `.dsToast` で「保存しました」と知らせる。

## 詳細画面

1つの項目を見せる画面。

- `List` の `Section` に、`DSRow` で項目の中身を並べる（値は `value:`）。
- 編集はツールバーの右の「編集」から編集画面を開く。削除は画面のいちばん下の `DSButton`（destructive）から `.dsConfirm` で確かめる。

## 設定画面

- `List` の `Section` ごとに、`DSToggleRow`・`DSPickerRow`・`DSRow`（`accessory: .chevron`）を並べる。
- 変えたらすぐに反映し、保存のボタンは置かない。

## 読み込みとエラー

- 読み込み中は、内容の場所に `DSLoading`。
- 読み込めなかったときは、画面の上に `DSBanner`（`.error`）と「再試行」。
