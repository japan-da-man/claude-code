# design-system 設計

アプリ全体の見た目の決まり（デザインシステム）を、人が決めて先に作り、育てていくための Claude Code プラグイン `design-system` の設計。

- 状態: 設計（2026-10-19 に一問一答で合意）
- 最初に対応するプラットフォーム: **iOS / SwiftUI**
- 関係するプラグイン: [factory](../factory/DESIGN.md)（デザインシステムを **使う側**）

## 1. 考え方

- **見た目の決まりは人が決める**。factory はレベル5（人はコードも画面も読まない）で機能を作るので、画面の細部を実装役がその場で決めると、誰も承認していない見た目が積み重なる。そこで、見た目の決まりは factory とは別のこのプラグインで、人が一問一答で決めて先に作っておく。factory はそれに従う側になる。
- **デザインシステムを変えるときも、factory には流さない**。人が `/design-system:update` で決める。
- **文書と、コードと、機械のチェックの3つで持つ**。文書は人と AI が読む決まり、SwiftUI のコードはその決まりを実際に描く部品、チェックは決まりが守られているかを機械で確かめるもの。factory の判定役（LLM）の目に頼らず、守られているかを機械で判定できるようにする。
- **正はアプリのリポジトリの中**。factory の裏のライン（`claude -p` と Codex）がファイルとしてそのまま読めて、`protected_paths` で守れる。claude.ai の Artifact には、人が眺める用に一方向で写すだけにする。
- **部品はこれから増える前提で、基本的なものは最初に全部作る**。機能を作るたびに「ボタンの形」を決め直さなくて済むようにする。

## 2. 決まったこと

| 項目 | 決定 |
| :- | :- |
| 名前 | `design-system`。コマンドは `/design-system:init`・`/design-system:update`・`/design-system:check` |
| 扱う中身 | トークン（色・文字・余白・角丸）、部品（基本的なものは最初に全部。5節）、文言の決まり、画面の型 |
| 置き場所 | 対象アプリのリポジトリ。文書と値は `design-system/`、SwiftUI のコードはアプリの中の `<アプリ>/DesignSystem/` |
| Artifact | claude.ai の Design System の Artifact に **一方向で写す**（非公開・ページ上の編集は不可）。部品はスクリーンショットで載せる。`--local` で写さない |
| 作り方 | 今のアプリのコードから使っている色・文字・余白・部品・文言を読み取って下書きにし、決まっていない点や揺れている点だけを一問一答で決める。コードがなければゼロから一問一答 |
| 見た目の確認 | アプリにデバッグ用の **カタログ画面**（起動引数で開く）を作り、シミュレーターでライトとダークのスクリーンショットを撮って見せる |
| 対応プラットフォーム | iOS / SwiftUI だけ。`tokens.json` と文書はプラットフォームに依らない形にして、あとで Web などの出力を足せるようにする |
| 既存の画面 | init のときに、今ある画面もデザインシステムの部品とトークンで書き換え、チェックが最初から通る状態にする |
| 機械のチェック | デザインシステムのフォルダの外の Swift コードで、直書きの色・直書きの文字・直書きの余白と角丸・部品を通さないボタンや入力欄を、ファイル:行つきで落とす |
| factory とのつなぎ | `design-system/design-system.json` に「入口の文書」「守るファイル」「チェックのコマンド」を書く。factory はこれを読む（factory 側の対応は別の PR。10節） |
| ない部品が要るとき | 機能のコードの中で、既存の部品とトークンだけを組み合わせて作る（直書きの値は使わない）。PR のレポートに「部品の候補」として載せ、人が `/design-system:update` で部品にするか決める |
| 質問の形 | AskUserQuestion による一問一答（選択肢つき、おすすめを先頭に「(Recommended)」、答えが前の答えに依存しない質問だけを最大4問まとめる） |
| スクリプト | Node の標準機能だけ。`node --test` のテストを先に書く |

## 3. 全体の流れ

```text
/design-system:init         アプリごとに1回
  1. アプリを調べる（iOS か、xcodeproj / project.yml、scheme、bundle id、画面のフォルダ）
  2. 今の見た目を読み取る（色・文字・余白・角丸・部品・文言・画面の形）→ 下書き
  3. 一問一答で決める（揺れている値、足りない役割、ダークモード、文言の調子、画面の型）
  4. 書く: design-system/ の文書と tokens.json、<アプリ>/DesignSystem/ の部品とカタログ画面
     Tokens.swift は tokens.json から生成する
  5. 今ある画面を部品とトークンで書き換える
  6. 確かめる: チェック・ビルドと全テスト・カタログと今の画面のスクリーンショット（ライト／ダーク）
  7. スクリーンショットを見せて承認をもらう（直したいところだけ対話で直す → 6 へ）
  8. コミットする。Artifact に写す

/design-system:update <変えたいこと>
  1. 今のデザインシステムを読む
  2. 一問一答で変え方を決める（部品の追加、色の変更、文言の決まりの追加など）
  3. 書き換える（文書・tokens.json・部品・カタログ）。Tokens.swift を作り直す
  4. 変更でチェックに引っかかるようになったアプリのコードも直す
  5. 確かめる（チェック・ビルドと全テスト・変わった前後のスクリーンショット）→ 承認
  6. コミットする。Artifact に写す

/design-system:check
  チェックを実行して、違反・古くなったもの（Tokens.swift、check.mjs、Artifact）を一覧にする。直さない
```

## 4. 置き場所

対象アプリのリポジトリの中（例はサンプルアプリ `FactorySample`）:

```text
design-system/
  design-system.json   設定。factory などの使う側が最初に読む入口（7節）
  README.md            入口の文書。原則、トークンの使いどころ、部品の一覧（いつどれを使うか）、ない部品が要るときの決まり
  tokens.json          トークンの値（Artifact の Design System と同じ形。6節）
  components.md        部品ごとの使い方（いつ使う・使わない、引数、状態）
  copy.md              文言の決まり
  patterns.md          画面の型
  check.mjs            機械のチェック（プラグインから写したもの。手で直さない）
  screenshots/         カタログ画面のスクリーンショット（<ページ>-light.png / -dark.png）
FactorySample/DesignSystem/
  Tokens.swift         tokens.json から生成（手で直さない）
  Components/*.swift   部品
  Catalog/*.swift      カタログ画面（#if DEBUG）
```

- `design-system/` と `<アプリ>/DesignSystem/` は、factory の `protected_paths` に入れて実装役が変えられないようにする（design-system.json の `protected_paths` に書いておく）。
- `check.mjs` をアプリのリポジトリに写すのは、プラグインを入れていない環境（factory の裏のライン、CI）でも `node design-system/check.mjs` だけで実行できるようにするため。init と update のたびにプラグインの版で上書きし、check はプラグインの版とずれていれば知らせる。

## 5. 部品（iOS / SwiftUI）

基本的なものは init で全部作る。プラグインに SwiftUI のひな形（`templates/ios/`）を持ち、init はそれをアプリに写してから、決まった値と文言に合わせて直す。ひな形が使うのは、6節の「必ずある役割」のトークンだけ。

| 種類 | 部品 | 中身 |
| :- | :- | :- |
| ボタン | `DSButton` | 種類: 主（primary）・副（secondary）・破壊的（destructive）・文字だけ（plain）。押せない状態、読み込み中 |
| | `DSIconButton` | アイコンだけのボタン（ツールバーなど）。読み上げ用のラベルを必須にする |
| 入力 | `DSTextField` | 1行の入力。ラベル、プレースホルダー、エラーのメッセージ |
| | `DSSecureField` | パスワードなど伏せ字の入力 |
| | `DSTextEditor` | 複数行の入力 |
| | `DSToggleRow` | オン・オフの切り替え（一覧の行） |
| | `DSPickerRow` | 選択肢から選ぶ（一覧の行） |
| 一覧 | `DSRow` | 一覧の行。タイトル、補足、先頭のアイコン、末尾の値や矢印 |
| | `DSSectionHeader` | 一覧の見出し（件数などの補足つき） |
| メッセージ | `DSInlineMessage` | 入力欄の下に出す短いメッセージ（エラー・注意・成功・情報） |
| | `DSBanner` | 画面の上に出す、画面全体に関わるメッセージ（通信できない、など）。やり直しのボタンつき |
| | `.dsToast` | 操作の結果を短く知らせて消える（「保存しました」） |
| | `.dsAlert` | 続けられないエラーを知らせる |
| | `.dsConfirm` | 取り消せない操作（削除など）の前の確認 |
| 状態 | `DSEmptyState` | 空の状態。アイコン、見出し、説明、最初の操作 |
| | `DSLoading` | 読み込み中 |
| その他 | `DSBadge` | 件数や状態の小さな印 |
| | `DSCard` | 一覧の外で、まとまりを囲む |

- 部品はアクセシビリティの識別子（`accessibilityIdentifier`）を呼び出し側から渡せるようにする。factory の検証役（agent-device）が画面を操作するのに使うため。
- 文字の大きさは Dynamic Type に合わせて大きくなるようにする。

## 6. トークン `tokens.json`

Artifact の Design System と同じ形（「名前・値・使いどころ」の一覧）にして、Artifact にそのまま写せるようにする。名前はプラットフォームに依らない kebab-case にし、Swift の名前（`DS.Color.textSecondary` など）は生成のときに作る。

```json
{
  "name": "メモ",
  "version": 1,
  "color": {
    "themes": [{ "id": "light", "name": "Light" }, { "id": "dark", "name": "Dark" }],
    "tokens": [
      { "name": "text-primary", "value": { "light": "#1c1c1e", "dark": "#f2f2f7" }, "usage": "本文と見出し" },
      { "name": "danger", "value": { "light": "#d70015", "dark": "#ff6961" }, "usage": "エラーと破壊的な操作" }
    ]
  },
  "type": {
    "families": { "sans": "system-ui, -apple-system, sans-serif" },
    "groups": [{ "name": "Text", "family": "sans", "styles": [
      { "name": "body", "fontSize": "17px", "lineHeight": "22px", "fontWeight": 400, "textStyle": "body" }
    ] }]
  },
  "spacing": { "tokens": [{ "name": "space-2", "value": "8px", "usage": "部品の中の要素の間" }] },
  "radius": { "tokens": [{ "name": "radius-md", "value": "10px", "usage": "ボタン、カード" }] }
}
```

- **必ずある役割**（ひな形の部品が使う）:
  - 色: `background`・`surface`・`text-primary`・`text-secondary`・`text-on-accent`・`accent`・`border`・`danger`・`warning`・`success`・`info`
  - 文字: `title`・`headline`・`body`・`callout`・`caption`
  - 余白: `space-1`〜`space-6`
  - 角丸: `radius-sm`・`radius-md`・`radius-lg`
- 役割は足してよい（足したものも Swift に生成される）。
- 色はライトとダークの両方に値を持つ。文字は `textStyle`（iOS の Dynamic Type の基準）を持ち、生成した Swift は文字の大きさの設定に合わせて大きくなる。
- 生成: `tokens.json` → `<アプリ>/DesignSystem/Tokens.swift`（`enum DS { enum Color … enum Font … enum Space … enum Radius … }`）。同じ入力からは同じ出力になる。チェックは、`Tokens.swift` が `tokens.json` から作り直したものと一致するかも確かめる。
- 値の検証: 名前の重複、必ずある役割の欠け、色の書き方（`#rgb`・`#rrggbb`・`#rrggbbaa`）、長さの単位（`px`）を確かめ、どのトークンの何が悪いかを返す。

## 7. 設定 `design-system/design-system.json`

factory などの使う側が最初に読む入口。

```json
{
  "version": 1,
  "platform": "ios",
  "docs": ["design-system/README.md", "design-system/components.md", "design-system/copy.md", "design-system/patterns.md"],
  "tokens": "design-system/tokens.json",
  "ios": {
    "project": "FactorySample.xcodeproj",
    "scheme": "FactorySample",
    "bundle_id": "com.japandaman.FactorySample",
    "device": "iPhone 17",
    "code": "FactorySample/DesignSystem",
    "sources": ["FactorySample"],
    "catalog_pages": ["colors", "type", "spacing", "buttons", "inputs", "rows", "messages", "states", "patterns"]
  },
  "protected_paths": ["design-system/**", "FactorySample/DesignSystem/**"],
  "check": { "command": "node design-system/check.mjs" },
  "artifact": { "url": "https://claude.ai/artifact/…", "hash": "…" }
}
```

- `protected_paths`: 実装役に変えさせないファイル。factory の init がこれを取り込む。
- `check.command`: 使う側が実行するコマンド。違反があれば終了コード 1。`--json` で結果を JSON で出す。
- `artifact`: 最後に写した Artifact と、写した中身のハッシュ（`--local` なら書かない）。

## 8. 機械のチェック `check.mjs`

`sources` の下の Swift ファイルのうち、`code`（デザインシステムのフォルダ）とテストを除いたものを調べる。コメントと文字列の中身は調べない。

| 決まり | 落とすもの（例） | 代わりに |
| :- | :- | :- |
| `color` | `.red`・`.secondary` などの色やスタイルを `foregroundStyle`・`background`・`tint` などに直接渡す、`Color.red`、`Color(red:…)`、`Color("…")`、`UIColor` | `DS.Color.*` |
| `font` | `DS.Font.*` 以外を渡す `.font(…)`、`.fontWeight(…)`、`.bold()`、`Font.system(…)`、`UIFont` | `DS.Font.*` |
| `spacing` | 数字を直接渡す `.padding(12)`・`.padding(.horizontal, 12)`・`spacing: 8`・`cornerRadius: 10`・`.cornerRadius(10)` | `DS.Space.*`・`DS.Radius.*` |
| `control` | `Button`・`TextField`・`SecureField`・`TextEditor`・`Toggle`・`Picker` をそのまま使う | `DSButton` などの部品 |

- どうしても必要な行は、その行か直前の行に `// design-system: allow <決まり> <理由>` と書けば通る。使った数は結果に出す。
- そのほかに確かめること（違反ではなく「古い」として出す）:
  - `Tokens.swift` が `tokens.json` から作り直したものと違う
  - `check.mjs` がプラグインの版と違う（プラグインがあるときだけ）
  - Artifact に写した中身が今のファイルと違う
- 出力: ふつうは人が読む一覧（`ファイル:行 決まり 該当箇所 → 代わりに`）。`--json` で `{ ok, violations, stale, allowed }`。

## 9. カタログ画面とスクリーンショット

- カタログ画面は `#if DEBUG` で作り、起動引数 `-DesignSystemCatalog <ページ>` で開く。ページは `catalog_pages`（色・文字・余白・ボタン・入力・一覧の行・メッセージ・状態・画面の型）。1ページは1画面に収める。
- init はアプリの入口（`@main`）に、起動引数を見てカタログを出す数行を足す。
- スクリーンショットはプラグインのスクリプトが撮る: `xcodegen generate`（`project.yml` があれば）→ `xcodebuild build`（DerivedData はリポジトリの外 `~/Library/Caches/design-system/<アプリ>/`）→ シミュレーターを起動 → 入れ直す → 時計などのステータスバーを固定 → ライトとダークそれぞれで各ページを起動して撮る。
- 今の画面（カタログでない、ふつうの起動）も撮って、書き換えの前後を見比べられるようにする。
- この Mac はメモリ 8GB でシミュレーターは1台ずつなので、factory のラインが動いている（`~/.factory/line.lock` のプロセスが生きている）ときは撮らずに知らせる。

## 10. factory とのつなぎ（factory 側は別の PR）

このプラグインが用意するのは 7節の設定と 8節のチェックまで。factory 側でやること:

1. `/factory:init`: `design-system/design-system.json` があるか確かめる。なければ `/design-system:init` を先に勧める。あれば、その `protected_paths` を `.factory/config.json` の `protected_paths` に入れる。
2. ラインの実装役のプロンプト: `docs` の文書を読み、部品とトークンだけで画面を作ること、ない部品は既存の部品とトークンで組み、レポートに「部品の候補」として書くこと。
3. ラインのゲート: ビルドと全テストのあとに `check.command` を実行し、違反があればその周は不合格として、違反の一覧（ファイル:行と決まり）を症状として実装役に渡す。自動マージの条件にも入れる。
4. シナリオ作成役とインタビュー役: `copy.md`（エラーや空の状態の言い方）と `patterns.md`（画面の型）を読み、期待する文言や画面の形をそれに合わせる。
5. PR のレポートに、実装役が挙げた「部品の候補」を載せる。

## 11. Artifact への写し

- 正はリポジトリ。init と update の最後に、claude.ai の Design System の Artifact へ **一方向で** 写す（ページ上の編集は `editing: off` で止める）。
- 写すもの: `tokens.json`（同じ形なのでそのまま）、`README.md`・`components.md`・`copy.md`・`patterns.md`（ブランドブックの節として）、カタログのスクリーンショット（アセットとして）、表紙。
- 写したら、写した中身のハッシュを `design-system.json` の `artifact.hash` に書く。check はハッシュが今のファイルと違えば「Artifact が古い」と知らせる。
- 写せるのは、Artifact のツールが使える手元のセッションだけ（update は人が行うので困らない）。`--local` なら写さない。

## 12. プラグインの構成

```text
plugins/design-system/
  .claude-plugin/plugin.json
  package.json                 node --test
  DESIGN.md
  skills/
    init/SKILL.md              /design-system:init
    update/SKILL.md            /design-system:update
    check/SKILL.md             /design-system:check
  scripts/
    check.mjs                  トークンの検証と Swift の生成、コードのチェック（1ファイルで完結。アプリに写す）
    cli.mjs                    スキルから呼ぶ CLI（tokens / install / screenshot / artifact-hash / status）
    ios.mjs                    シミュレーターのビルドとスクリーンショット
  templates/ios/DesignSystem/  部品とカタログ画面のひな形
  tests/                       node --test
```

## 13. リスクと未解決の点

- **チェックは正規表現**。Swift を構文解析しないので、書き方によっては見逃しや誤検知がある。誤検知は `allow` のコメントで逃がし、見逃しは見つけたら決まりを足す。
- **カタログ画面と実際の画面のずれ**。カタログは部品を並べた画面なので、組み合わせたときの見た目までは保証しない。init の書き換えの前後の比較と、update の前後の比較で補う。
- **ひな形の部品はアプリごとに直す**。ひな形のままだとどのアプリも同じ見た目になる。init の一問一答で、アプリの見た目に合わせて直す。
- **Artifact のプレビュー**。Artifact の部品プレビューは HTML 用なので、SwiftUI の部品はスクリーンショットでしか見せられない。
