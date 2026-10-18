# デザインシステム

このアプリの見た目の決まり。人が `/design-system:init` と `/design-system:update` で決めたもので、画面を作る人と AI（factory の実装役など）は、これに従う。**ここに書かれていない見た目を、その場で決めない。**

## 文書

| ファイル | 中身 |
| :- | :- |
| [README.md](README.md) | 入口（この文書）。原則、トークンの使いどころ、部品の一覧、ない部品が要るときの決まり |
| [components.md](components.md) | 部品ごとの使い方 |
| [copy.md](copy.md) | 文言の決まり（エラー・空の状態・ボタン・確認の言い方） |
| [patterns.md](patterns.md) | 画面の型（一覧・編集など） |
| [tokens.json](tokens.json) | トークンの値（色・文字・余白・角丸） |
| [screenshots/](screenshots) | カタログ画面のスクリーンショット（ライト／ダーク） |
| design-system.json | 設定（使う側が読む入口。守るファイル、チェックのコマンド） |
| check.mjs | 機械のチェック（プラグインから写したもの。手で直さない） |

## 原則

<!-- init の一問一答で、このアプリの見た目の方針を 3〜5 行で書く（例: iOS の標準に近づける、色は accent の 1 色だけ、など） -->

## トークン

値は [tokens.json](tokens.json)、Swift からは `DS.Color.*`・`DS.Font.*`・`DS.Space.*`・`DS.Radius.*` で使う（`Tokens.swift` は tokens.json から生成する。手で直さない）。

- **色**: 色は必ず `DS.Color.*` から選ぶ。`.red` や `Color(red:…)` などを直接書かない。ライトとダークの値は tokens.json が持つ。
- **文字**: 文字は必ず `DS.Font.*` から選ぶ。`.font(.caption)` や `.bold()` を直接書かない。どれも Dynamic Type に合わせて大きくなる。
- **余白と角丸**: 数字を直接書かず、`DS.Space.*`・`DS.Radius.*` を使う（`0` と、引数なしの `.padding()` はよい）。

<!-- 各トークンの使いどころは tokens.json の usage に書く。ここには、組み合わせの決まり（例: accent の上の文字は text-on-accent）を書く -->

## 部品

ボタンと入力欄は、SwiftUI の `Button`・`TextField` などをそのまま使わず、必ず部品を使う。使い方は [components.md](components.md)。

| 種類 | 部品 |
| :- | :- |
| ボタン | `DSButton`（primary・secondary・destructive・plain）、`DSIconButton` |
| 入力 | `DSTextField`、`DSSecureField`、`DSTextEditor`、`DSToggleRow`、`DSPickerRow` |
| 一覧 | `DSRow`、`DSSectionHeader`、`.dsListStyle()`、`.dsRowBackground()` |
| メッセージ | `DSInlineMessage`、`DSBanner`、`.dsToast`、`.dsAlert`、`.dsConfirm`（中身は `DSMessage`） |
| 状態 | `DSEmptyState`、`DSLoading` |
| その他 | `DSBadge`、`DSCard` |

## ない部品が要るとき

1. 機能のコードの中で、**既存の部品とトークンだけを組み合わせて**作る。直書きの値は使わない。
2. 作ったものは、PR のレポートなどに「部品の候補」として、どこで何のために作ったかを書く。
3. 部品にするかは、人が `/design-system:update` で決める。デザインシステムのファイル（`design-system/` と、アプリの中の `DesignSystem/`）は、機能を作るときには変えない。

## 決まりを破るとき

どうしても必要な行だけ、その行か直前の行に `// design-system: allow <決まり> <理由>` と書く（決まりは `color`・`font`・`spacing`・`control`）。チェックは通るが、数は記録される。

## チェック

```bash
node design-system/check.mjs
```

直書きの色・文字・余白と角丸、部品を通さないボタンや入力欄を、ファイル:行つきで出す。違反があれば終了コード 1。
