---
name: init
description: factory を使う前に、プロジェクトごとに 1 回だけ行う初期設定。プロジェクトの種類を判定し、触ってはいけないファイルを決め、.factory/config.json を作る。必要な道具（Xcode、xcodegen、agent-device、gh）も確かめる。「factory を使えるようにして」「/factory:init」と言われたとき、/factory:start で設定がないと言われたときに使う。
allowed-tools: Bash(xcodebuild -list *) Bash(xcodebuild -showBuildSettings *) Bash(xcodebuild build-for-testing *) Bash(xcodebuild test-without-building *) Bash(xcrun simctl list *) Bash(command -v *) Bash(gh auth status*) Bash(git remote -v)
---

# factory:init: 工場の初期設定

このリポジトリで factory を使えるようにする。書くのは `.factory/config.json` だけで、アプリのコードは変えない。

## 1. 種類を判定する

リポジトリを見て判定する（いまは iOS だけに対応）。

- `*.xcodeproj` か、XcodeGen の `project.yml` があれば **iOS**。
- どちらもなければ、「いまは iOS アプリにだけ対応しています」と伝えて終える。

iOS なら、次を調べる（推測で埋めない）。

- `project`: `.xcodeproj` のパス（`project.yml` しかなければ、生成される `<name>.xcodeproj`）
- `scheme`: `xcodebuild -list -json -project <project>` の schemes から、アプリのもの
- `bundle_id`: `xcodebuild -showBuildSettings -project <project> -scheme <scheme>` の `PRODUCT_BUNDLE_IDENTIFIER`
- `device`: `xcrun simctl list devices available` にある iPhone から（既定は `iPhone 17`）

`project.yml` しかなく、まだ `.xcodeproj` が生成されていないときは、先に `xcodegen generate` が必要だと伝え、許可を得てから実行する。

判定した結果を AskUserQuestion で見せて、合っているか確かめる。

## 2. デザインシステムを確かめる

`design-system/design-system.json`（design-system プラグインが作る）があるか確かめる。

- **ある**：その `protected_paths`（例: `design-system/**` と `<アプリ>/DesignSystem/**`）は、ラインが自動で禁止ファイルに足すので、ここで書き写さなくてよい。実装役は部品とトークンだけで画面を作り、`check.command` のチェックもマージの条件になる、と伝える。
- **ない**：factory はレベル5（人が画面を見ない）なので、見た目の基準がないと機能ごとに見た目がばらつく。AskUserQuestion で「先に `/design-system:init` でデザインシステムを作る（Recommended）」か「今はなしで進める」かを尋ねる。先に作るなら、ここで終えて `/design-system:init` を案内する。

## 3. 前提のデータを仕込む口を用意する

検証役は、毎回アプリを入れ直した直後の状態から操作する。そのままでは「古い版で保存したデータがある」「メモが 100 件ある」のような前提を作れず、大事な確認ができない。そこで、**DEBUG のときだけ動く、データを仕込む口** をアプリに足すかを AskUserQuestion で尋ねる（足す (Recommended) / 今は足さない）。

`.factory/seed.md` がすでにあれば、この段階は飛ばす（仕込みの口 `**/FactorySeed.swift` と `.factory/**` は、設定に関係なくラインが必ず禁止ファイルとして扱う）。足すときは:

1. アプリがデータをどこにどう保存しているか（UserDefaults、ファイル、SwiftData など）を読む。
2. `<アプリ>/FactorySeed.swift` を書く。全体を `#if DEBUG` で囲み、起動引数 `-FactorySeed <JSON を Base64 にしたもの>`（`UserDefaults.standard.string(forKey: "FactorySeed")`）があれば、Base64 を JSON に戻して、そのデータを **アプリのふつうの保存の仕組みを通して** 保存する。値を Base64 にするのは、`{` で始まる起動引数を iOS が property list として読んでしまうため。保存のあとは、すぐディスクに書き出す（ラインは仕込んだ直後にアプリを止める。UserDefaults なら `synchronize()`）。リリースのビルドには入らないようにする。
3. アプリの入口で、保存したデータを読み込む **前に** 仕込むようにする（例: `@main` の `init()` で、ストアを作る前に `FactorySeed.applyIfRequested()` を呼ぶ）。
4. `.factory/seed.md` に、JSON の形（キーと値の意味）と例を書く。シナリオ作成役は、これを見て前提のデータを書く。
5. 試す: ビルドしてアプリを入れ、`xcrun simctl launch <udid> <bundle_id> -FactorySeed "$(printf '%s' '<例の JSON>' | base64)"` で一度起動して閉じ、ふつうに起動し直してデータが見えるか（スクリーンショットで）確かめる。保存は アプリの中の場所にあるので、`simctl spawn … defaults read` では見えない。全テストも通す。
6. 次の段階の禁止ファイルに、`<アプリ>/FactorySeed.swift` と `.factory/seed.md` を必ず入れる（実装役が変えないように）。

## 3.5 シナリオの XCUITest を流すターゲットを用意する

シナリオ作成役は、機械で確かめられるシナリオには XCUITest も書く。ラインはまずそれを流し、通れば LLM の検証役を呼ばない（1 本数秒。検証役は 1 本 1 分以上かかる）。そのための UI テストのターゲット `FactoryUITests` を足すかを AskUserQuestion で尋ねる（足す (Recommended) / 今は足さない）。`ios.ui_tests` がすでに設定にあれば飛ばす。

1. ターゲットを足す。
   - **XcodeGen（`project.yml`）**：`targets` に次を足し、アプリのスキームの `test.targets` にも `FactoryUITests` を足して、`xcodegen generate` する。
     ```yaml
     FactoryUITests:
       type: bundle.ui-testing
       platform: iOS
       sources: [FactoryUITests]
       dependencies:
         - target: <アプリのターゲット>
     ```
   - **`.xcodeproj` だけのとき**：`project.pbxproj` を手で書き換えない。人に、Xcode の File › New › Target › UI Testing Bundle で `FactoryUITests` を足してもらう（Xcode 16 以降は、フォルダに置いたファイルが自動でターゲットに入る）。アプリのスキームの Test に入っていることも確かめてもらう。
2. `FactoryUITests/FactoryPlaceholderTests.swift` を書く（中身は `import XCTest` と、テストのない `final class FactoryPlaceholderTests: XCTestCase {}`）。フォルダが空だとターゲットが作れないため。
3. 試す: `xcodebuild build-for-testing` が通り、`xcodebuild test-without-building … -only-testing:FactoryUITests/FactoryPlaceholderTests` が終了コード 0 で終わることを確かめる。
4. 設定に `"ui_tests": { "target": "FactoryUITests", "dir": "FactoryUITests" }` を `ios` の中に書く。ラインは `FactoryUITests/**` を、設定に関係なく禁止ファイルとして扱う（シナリオの XCUITest は、検証のときだけラインが入れる）。

## 4. 触ってはいけないファイルを決める

リポジトリを見て、実装役に変えさせたくないファイルの候補を出す。候補の例:

- 署名・権限: `**/*.entitlements`、署名やチーム ID の設定ファイル
- CI: `.github/workflows/**`
- 工場の設定: `.factory/**`（必ず入れる）
- 認証・課金・個人情報を扱うコードのフォルダ（あれば）
- データの移行（マイグレーション）

`project.pbxproj` は、ファイルを足すたびに変わるので **候補に入れない**。

AskUserQuestion（multiSelect）で候補を見せ、選ばれたものを `protected_paths` にする。

## 5. 設定を書く

`.factory/config.json` を次の形で書く。新しく作るときは、ここで決めた値以外は書かない（既定値が使われる）。**すでにあるときは、ここで決めた値だけを書き換え、ほかの値（`satisfaction`・`max_rounds`・`models` など）はそのまま残す。**

```json
{
  "type": "ios",
  "ios": { "project": "...", "scheme": "...", "bundle_id": "...", "device": "..." },
  "protected_paths": ["..."]
}
```

`swiftlint` があり（`command -v swiftlint`）、リポジトリに `.swiftlint.yml` があれば、`"quality": { "lint": "swiftlint lint --strict" }` を足すか AskUserQuestion で尋ねる。

既定値:

- モデル: インタビュー・シナリオ・判定が `opus`、実装・検証・破壊役が `sonnet`、レビューが `codex`（Codex がなければ `sonnet` にする）
- 満足度: 95% 以上。各シナリオはまず 1 回流し、落ちたときだけ 3 回まで流し直す（`satisfaction.rerun: "on_failure"`）
- 周回の上限: 5
- 陰性対照: 実装の前に今のアプリでシナリオを流す（`control.base: true`）。壊したアプリを流す破壊役は無効（`control.mutant: false`）
- 品質関門: テストのファイルが足されていること、変更が 800 行以内（超えたら Draft PR で人が見る）、別のモデルのレビューを PR に載せる（`quality`）

## 6. 道具を確かめる

次がそろっているか確かめ、足りないものは **入れ方を伝えるだけ** にする（勝手に入れない）。

| 道具 | 確かめ方 | 入れ方 |
| - | - | - |
| Xcode と iOS シミュレーター | `xcrun simctl list devices available` | App Store の Xcode |
| xcodegen（`project.yml` があるときだけ） | `command -v xcodegen` | `brew install xcodegen` |
| agent-device | `command -v agent-device` | `npm install -g agent-device` |
| gh（ログイン済み） | `gh auth status` | `brew install gh` → `gh auth login` |
| GitHub のリモート | `git remote -v` に `origin` | GitHub にリポジトリを作って push |

## 7. 終わりに

作った設定と、足りない道具があればその一覧を伝える。`.factory/config.json` をコミットするよう勧め、次は `/factory:start <作りたい機能>` で始められると伝える。
