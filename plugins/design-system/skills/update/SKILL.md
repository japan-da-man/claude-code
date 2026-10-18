---
name: update
description: デザインシステムを変える（部品の追加、色・文字・余白の変更、文言の決まりや画面の型の追加、factory が挙げた「部品の候補」を部品にする）。人が一問一答で決め、文書・トークン・部品・カタログを直し、変更で決まりに合わなくなったアプリのコードも直して、前後のスクリーンショットで承認をもらう。「デザインシステムに〇〇を足して」「ボタンの色を変えたい」「/design-system:update <変えたいこと>」と言われたときに使う。
argument-hint: "<変えたいこと> [--local]"
model: opus
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(node design-system/check.mjs*) Bash(xcodebuild test *) Bash(xcodegen generate*) Bash(git fetch *) Bash(git status*) Bash(git rev-parse *) Bash(git diff*) Bash(git add *) Bash(git commit *)
---

# design-system:update: デザインシステムを変える

変えたいこと: $ARGUMENTS

デザインシステムは人が決めるもの。factory には流さず、ここで一問一答で決めてから変える。設計は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`。

0. 準備 → 1. 今のデザインシステムを読む → 2. 前のスクリーンショット → 3. 一問一答で決める → 4. 書き換える → 5. アプリのコードを合わせる → 6. 確かめる → 7. 承認 → 8. コミット → 9. Artifact に写す、の順に進める。

質問は必ず **AskUserQuestion** で出す。本文に質問を並べない。1 回に出すのは、答えが前の答えに依存しない質問だけ（最大 4 問）。選択肢をつけ、おすすめは先頭にして「(Recommended)」を付ける。調べれば分かることは質問しない。

## 0. 準備

- 引数に `--local` があれば外し、9 の Artifact への写しをしない。
- 対象のアプリのリポジトリを決める（`git rev-parse --show-toplevel`。アプリでなければ AskUserQuestion でパスを尋ね、以降は `cd <repo> && …` で実行する）。
- `design-system/design-system.json` がなければ、先に `/design-system:init` を実行するよう伝えて終える。
- 変えたいことが空なら、何を変えたいか尋ねる。
- `git fetch -q origin` のあと `git status -sb` を見て、遅れていれば pull してよいか尋ねる。

## 1. 今のデザインシステムを読む

`design-system/` の文書 4 つと `tokens.json`、`<code>/` の部品とカタログを読む。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status <repo>
```

で今の違反と古くなったものも見ておく（変更とは別の違反があれば、最初にユーザーに伝える）。

## 2. 前のスクリーンショット

変更で見た目が変わりそうなカタログのページ（とアプリの画面）を、比べるために撮っておく。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs screenshot <repo> --pages <ページ,…> [--app] --out <スクラッチのフォルダ>/before
```

数分かかるので、Bash のタイムアウトを長め（10 分）にする。

## 3. 一問一答で決める

変えたいことを、決めるべき点に分けて AskUserQuestion で聞く。よくある変更と、決める点:

| 変更 | 決める点 |
| :- | :- |
| 部品を足す | 何のための部品か、似た部品で足りないか、見た目と状態（押せない・エラーなど）、引数、どの画面で使うか、名前（`DS` で始める） |
| 色・文字・余白・角丸を変える | 新しい値（色はライトとダーク、文字に使う色はコントラスト比 4.5:1 以上をおすすめに）、どの役割まで変えるか |
| 文言の決まりを足す・変える | 決まりと例。今のアプリの文がその決まりに合わなくなるなら、直すか |
| 画面の型を足す | どんな画面か、使う部品、操作の場所 |
| 部品の候補（factory の PR のレポートなど）を部品にする | 候補のコードを読み、部品にするか、既存の部品を広げるか |

## 4. 書き換える

- まず、プラグインの新しい版を取り込む（`check.mjs` を上書きし、ないひな形だけ足す。今の部品と文書は上書きしない）:

  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs install <repo>
  ```

- **トークン**: `design-system/tokens.json` を直してから、Swift を作り直す（`Tokens.swift` は手で直さない）:

  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs tokens <repo>
  ```

- **部品**: `<code>/Components/` に足す・直す。色・文字・余白はトークンだけを使う。識別子の決まり（`components.md` の「識別子」）に合わせる。
- **カタログ**: 足した部品は、カタログの合うページに並べる。ページを足したら、`DesignSystemCatalogView.pages` と `design-system.json` の `ios.catalog_pages` の両方に足す。1 ページは 1 画面に収める。
- **文書**: `README.md` の部品の表、`components.md`、`copy.md`、`patterns.md` を変更に合わせる。
- 部品を足したことで、使う側が守るべき決まり（`check.mjs` の `control` など）が変わるなら、README の「チェック」にも書く。

## 5. アプリのコードを合わせる

```bash
node design-system/check.mjs
```

変更で決まりに合わなくなったアプリのコード（消したトークンや、名前を変えた部品を使っているところ）を直す。部品の候補を部品にしたときは、候補のコードを新しい部品に置き換える。動き（ロジック）と `accessibilityIdentifier` は変えない。違反がなくなるまで繰り返す。

## 6. 確かめる

1. `node design-system/check.mjs` が違反なしで終わる。
2. 全テストが通る（`project.yml` があれば先に `xcodegen generate`）:

   ```bash
   xcodebuild test -quiet -project <project> -scheme <scheme> -destination 'platform=iOS Simulator,name=<device>'
   ```

3. 変わったページを撮る（`design-system/screenshots/` に入る）。カタログ全部を撮り直すなら `--pages` を付けない:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs screenshot <repo> --pages <ページ,…> [--app]
   ```

4. 撮った画像を Read で自分で見て、崩れがあれば直して撮り直す。

## 7. 承認

前と後のスクリーンショットを並べて見せる（ファイルを送る道具があれば送り、なければパスを伝える）。AskUserQuestion で「この変更で承認する / 直したいところがある」を確かめ、直すなら 3 に戻る。

## 8. コミット

変わったファイルを確かめてコミットする。メッセージはリポジトリの書き方に合わせ、何を変えたかを書く（例: `Design system: add DSSearchField`）。push はしない（ユーザーに尋ねる）。

## 9. Artifact に写す

`--local` か、`design-system.json` に `artifact` がなければ飛ばす（`artifact` がなく、写したいと言われたら `/design-system:init` の 9 と同じ手順で作る）。

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs artifact-stage <repo> <スクラッチのフォルダ>/artifact` で、写すファイルを並べる。
2. `artifact.url` の Artifact を `action: "read"` で読み、型の手順（SKILL.md の「Revising a system」）に従って、変わったファイルだけを写す（スクリーンショットはアセットを上げ直して索引の記録を差し替える。索引は最後に読み直してから書く）。
3. `node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs artifact-done <repo> <url>` で写した中身のハッシュを記録し、コミットする。

## 終わりに

変えたこと、直したアプリのコード、スクリーンショットの場所（と Artifact の url）を短く伝える。factory を使っていて、部品や決まりを足したなら、次に factory で作る機能からそれが使われることを伝える。
