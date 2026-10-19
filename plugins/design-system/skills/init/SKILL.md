---
name: init
description: アプリの見た目の決まり（デザインシステム）を最初に作る。今のコードから色・文字・余白・部品・文言・画面の形を読み取り、決まっていない点を一問一答で決めて、文書・トークン・SwiftUI の部品・カタログ画面・機械のチェックを置き、今の画面も部品とトークンで書き換える。「デザインシステムを作って」「/design-system:init」と言われたとき、factory から先にデザインシステムを作るよう言われたときに使う。アプリごとに 1 回。
argument-hint: "[--local]"
model: opus
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(node design-system/check.mjs*) Bash(xcodebuild -list *) Bash(xcodebuild -showBuildSettings *) Bash(xcodebuild test *) Bash(xcodegen generate*) Bash(xcrun simctl list *) Bash(git fetch *) Bash(git status*) Bash(git rev-parse *) Bash(git diff*) Bash(git add *) Bash(git commit *)
---

# design-system:init: デザインシステムを作る

引数: $ARGUMENTS

アプリの見た目の決まりを、**人が決めて** 先に作る。factory などの画面を作る側は、これに従うだけになる。設計は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`。

0. 準備 → 1. アプリを調べる → 2. 今の見た目を読み取る → 3. 一問一答で決める → 4. 書く → 5. 今の画面を書き換える → 6. 確かめる → 7. 承認 → 8. コミット → 9. Artifact に写す、の順に進める。

質問は必ず **AskUserQuestion** で出す。本文に質問を並べない。1 回に出すのは、答えが前の答えに依存しない質問だけ（最大 4 問）。選択肢をつけ、おすすめは先頭にして「(Recommended)」を付ける。**調べれば分かること（今の値、画面の作り、Xcode の設定）は質問せず、自分で調べる。**

## 0. 準備

- 引数に `--local` があれば、9 の Artifact への写しをしない。
- 対象のアプリのリポジトリを決める。`git rev-parse --show-toplevel` がアプリのリポジトリ（`*.xcodeproj` か `project.yml` がある）でなければ、AskUserQuestion でパスを尋ね、以降のコマンドはすべてそのパスで実行する（`cd <repo> && …`）。
- `design-system/design-system.json` がすでにあれば、作り直さずに `/design-system:update` を勧めて終える。
- `git fetch -q origin` のあと `git status -sb` を見る。origin より遅れていたら pull してよいか尋ねる。まだコミットしていない変更があれば、それを伝えて続けてよいか尋ねる（あとで書き換えた分と混ざるため）。

## 1. アプリを調べる

いまは iOS（SwiftUI）だけに対応する。`*.xcodeproj` も `project.yml` もなければ、そう伝えて終える。

次を調べる（推測で埋めない）。`.factory/config.json` があれば、`ios` の値をそのまま使ってよい。

- `project`・`scheme`・`bundle_id`: `xcodebuild -list -json -project <project>` と `xcodebuild -showBuildSettings -project <project> -scheme <scheme>`（`project.yml` しかなく `.xcodeproj` がなければ、先に `xcodegen generate`）
- `device`: `xcrun simctl list devices available` の iPhone（既定は `iPhone 17`）
- `sources`: アプリのターゲットの Swift のフォルダ（`project.yml` の `sources`、なければ `.xcodeproj` と同じ名前のフォルダ）
- `code`: デザインシステムのコードの置き場所。`<sources の最初>/DesignSystem`
- 新しいファイルがビルドに入るか: `project.yml` があれば `xcodegen generate` で入る。`.xcodeproj` だけなら、`project.pbxproj` に `PBXFileSystemSynchronizedRootGroup`（フォルダと同期するグループ）があれば入る。どちらでもなければ、ユーザーに Xcode で `DesignSystem` フォルダを足してもらう必要があると伝える。

## 2. 今の見た目を読み取る

`sources` の Swift をすべて読み、次を表にまとめる（ファイル:行つき）。アプリが大きければ、Explore のサブエージェントに分けて調べさせてよい。

| 観点 | 読み取るもの |
| :- | :- |
| 色 | `.red`・`.secondary`・`Color(…)`・アセットカタログの色（`AccentColor` など）。どの役割（エラー、補足の文字、背景…）に使っているか |
| 文字 | `.font(…)`・`.bold()` など。どの役割（見出し、本文、補足…）に使っているか |
| 余白と角丸 | `.padding(…)`・`spacing:`・`cornerRadius` の数字 |
| 部品 | ボタン・入力欄・一覧の行・メッセージ・空の状態・確認の出し方と、その見た目 |
| 文言 | 画面に出る文（エラー、空の状態、ボタン、見出し、確認）。調子・文末・数字と単位の書き方 |
| 画面 | 画面ごとの型（一覧・編集・詳細・設定）と、追加や削除の操作の場所 |
| 識別子 | `accessibilityIdentifier`（factory の検証役やテストが使うので、書き換えても残す） |

`node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs` はまだ使わない。役割（6 節の「必ずある役割」: 色 11・文字 5・余白 6・角丸 3）ごとに、今の値と、揺れているところ（同じ役割に違う値）・決まっていないところ（今は使っていない役割）を下書きにする。

## 3. 一問一答で決める

下書きを短く見せてから、次の **観点リスト** が全部埋まるまで AskUserQuestion で聞く。今のコードで揃っていて迷いがないものは、「今の値のままにする」をまとめて 1 問で確かめる。ユーザーが「もう十分」と言ったら、残りはおすすめの値で埋める。

1. 見た目の方針（iOS の標準に寄せる、ブランドの色を出す、など）。README の「原則」に書く
2. accent の色と、ダークモードに対応するか（色はライトとダークの両方の値を決める）
3. 状態の色（エラー・注意・成功・お知らせ）と、背景・面・文字・枠の色
4. 文字（システムの文字か、ほかの書体か。見出し・本文・補足の大きさと太さ）
5. 余白の刻みと角丸
6. 部品の形（ボタンの塗りと角、入力欄は一覧の中か枠つきか、メッセージの出し方）
7. 文言の調子（です・ます、文末の「。」、数字と単位、ボタンは動詞か、確認と取り消しの言い方）
8. 画面の型（今の画面をどの型にするか、追加・削除・保存の操作の場所）

色を聞くときは、選択肢の説明に HEX と、白（ダークなら黒）の背景での文字のコントラスト比を書く。文字に使う色は 4.5:1 以上をおすすめにする。

## 4. 書く

1. `design-system/design-system.json` を書く（1 で調べた値。`catalog_pages` はこのまま）:

   ```json
   {
     "version": 1,
     "platform": "ios",
     "docs": ["design-system/README.md", "design-system/components.md", "design-system/copy.md", "design-system/patterns.md"],
     "tokens": "design-system/tokens.json",
     "ios": {
       "project": "<project>", "scheme": "<scheme>", "bundle_id": "<bundle_id>", "device": "<device>",
       "code": "<code>", "sources": ["<sources>"],
       "catalog_pages": ["colors", "type", "spacing", "buttons", "inputs", "rows", "messages", "dialogs", "states", "patterns"]
     },
     "protected_paths": ["design-system/**", "<code>/**"],
     "check": { "command": "node design-system/check.mjs" }
   }
   ```

2. 書き換える前の画面を撮っておく（比べるため。リポジトリの外に置く）:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs screenshot <repo> --pages "" --app --out <スクラッチのフォルダ>/before
   ```

   数分かかるので、Bash のタイムアウトを長め（10 分）にする。factory のラインが動いているとエラーになるので、終わるのを待つ。

3. ひな形を置く:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs install <repo>
   ```

   `design-system/check.mjs`・`design-system/shoot.mjs`（撮影。factory の UI 案の撮影も使う）、`tokens.json`、文書 4 つ、`<code>/` の部品とカタログ、`Tokens.swift` ができる（すでにあるファイルは上書きしない）。

4. `design-system/tokens.json` を、3 で決めた値に書き換える。「必ずある役割」は消さない。`usage` には、その色や文字をどこに使うかをユーザーの言葉で書く。役割を足してもよい（名前は小文字の kebab-case）。書いたら Swift を作り直す:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs tokens <repo>
   ```

   `errors` があれば直してやり直す。

5. 部品（`<code>/Components/`）を、3 で決めた形と文言に合わせて直す（ボタンの形、確認の「キャンセル」、知らせを閉じる「OK」など）。部品の外のコードはまだ触らない。
6. 文書を書く。README の「原則」、`copy.md`、`patterns.md` を 3 の答えで書き、`components.md` を直した部品に合わせる。ひな形の `<!-- … -->` のコメントは消す。例の文はこのアプリの画面の言葉にする。
7. カタログ（`<code>/Catalog/DesignSystemCatalog.swift`）の例の文と「画面の型」のページを、このアプリの画面に合わせて直す。
8. アプリの入口（`@main` の `WindowGroup` の中の最初の画面）に `.designSystemCatalog()` を付ける。DEBUG のときだけ、起動引数 `-DesignSystemCatalog <ページ>` でカタログが開く。

## 5. 今の画面を書き換える

```bash
node design-system/check.mjs
```

出た違反を、部品とトークンを使って 1 つずつ直す。

- 見た目は 3 で決めたものにし、**動き（ロジック）は変えない**。
- `accessibilityIdentifier` は残す（入力欄と空の状態は `id:`、メッセージは `DSMessage` の `id` に移す。`components.md` の「識別子」）。
- ビルドに `.xcodeproj` の生成が要るなら `xcodegen generate` を実行する。
- どうしても部品で書けない行だけ `// design-system: allow <決まり> <理由>` を付け、ユーザーに理由を伝える。

違反がなくなるまで繰り返す。

## 6. 確かめる

1. `node design-system/check.mjs` が違反なしで終わる。
2. 全テストが通る:

   ```bash
   xcodebuild test -quiet -project <project> -scheme <scheme> -destination 'platform=iOS Simulator,name=<device>'
   ```

   書き換えでテストが落ちたら、テストではなく書き換えを直す（見た目のために振る舞いを変えない）。
3. カタログとアプリの画面を撮る（`design-system/screenshots/` に入る）:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs screenshot <repo> --app
   ```

4. 撮った画像を Read で自分で見て、崩れ（はみ出し、重なり、読めない色、1 画面に収まっていないページ）があれば直して撮り直す。

## 7. 承認

ユーザーにスクリーンショットを見せる。ファイルを送る道具（SendUserFile など）があれば、ライトとダークのカタログと、書き換えの前後のアプリの画面を送る。なければパスを伝える。

1 回の AskUserQuestion で、「直したいページ（multiSelect。カタログのページとアプリの画面。「直すものはない」も選べる）」を聞く。選ばれたページだけ、1 つずつ AskUserQuestion で直し方を聞いて直し、6 からやり直す。最後に「このデザインシステムで承認する」を AskUserQuestion で確かめる。

## 8. コミット

`git status` で変わったファイルを確かめ、`design-system/`、`<code>/`、書き換えたアプリのコード、（あれば）`project.yml` をコミットする。メッセージはリポジトリの書き方に合わせる（例: `Add the design system: tokens, components, copy rules and screen patterns`）。push はしない（push するかユーザーに尋ねる）。

## 9. Artifact に写す

`--local` なら飛ばす。正はリポジトリで、Artifact には **一方向で** 写す（人が眺める用）。

1. 写すファイルを並べる:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs artifact-stage <repo> <スクラッチのフォルダ>/artifact
   ```

   `files`（`project/` に置いた tokens.json と文書）、`screenshots`（上げる画像。アップロードできるよう、同じフォルダの `screenshots/` に写してある）、`hash` が出る。
2. Artifact の型の一覧（`Artifact` の `action: "quickstart"`、`intent: "other"`）から **Design System** の型を選び、`type_url` とアプリの名前の `title` で作る。作った結果に出る型の手順（SKILL.md）と、`artifact-type/reference/cover.md` に従って、`project/` の下に写す:
   - スクリーンショットは `file_paths` でまとめてアセットとして上げ（1 回 25 枚まで）、索引の `assetGroups.Screenshots` に、カタログのページ順・ライトのあとにダークの順で記録する。
   - `project/assets/Screenshots/README.md` に、カタログ画面のスクリーンショットであることと、**正はリポジトリで、このページで直してもリポジトリには戻らない** ことを書く。
   - `tokens.json` はそのまま（同じ形にしてある）。`README.md` が本文、`components.md`・`copy.md`・`patterns.md` はその節になる。
   - 表紙（`project/components/Cover/preview.html`）は型の手順どおり、トークンの色と角丸から作る。
   - 索引（`project/design-system.json`）は `"editing": "off"` にして、ページの上で直せないようにする（一方向の写しなので）。`lastChange.via` は `design-system plugin`。
   - 索引と残りのファイルは 1 回の `publish`（`root` に並べたフォルダ、`file_path` に索引）で送る。
3. 写し終えたら、url と中身のハッシュを記録して、コミットする:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs artifact-done <repo> <Artifact の url>
   ```

## 終わりに

次を短く伝える。

- 作ったもの（トークンの数、部品、文書、カタログのページ、書き換えた画面）と、`allow` で通した行があればその理由
- 見た目の確認に使ったスクリーンショットの場所と、Artifact の url（Artifact は非公開。ほかの人に見せるときはページの共有メニューから共有する）
- これからの変え方は `/design-system:update <変えたいこと>`、守られているかは `/design-system:check`（`node design-system/check.mjs`）で確かめられること
- factory を使っているなら、`design-system/design-system.json` の `protected_paths` を `.factory/config.json` の `protected_paths` に足すとよいこと
