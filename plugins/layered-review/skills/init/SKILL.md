---
name: init
description: アプリのリポジトリで layered-review を使えるようにする初期設定。REVIEW.md（何が大事か・指摘しないこと）、review/config.json（回すチェック・高リスクのパス・レビューの深さ・往復の上限・人の承認）、プラグインなしで動くチェッカー（review/check.mjs）、eval の置き場所、CI・PR テンプレート（テスト・リスク・戻し方）・CODEOWNERS を置き、人が GitHub で設定することを一覧で渡す。「レビューの仕組みを入れて」「REVIEW.md を作って」「/layered-review:init」と言われたときに使う。リポジトリごとに 1 回。
argument-hint: "[--no-pr]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs *) Bash(node review/check.mjs*) Bash(git *) Bash(gh auth status*) Bash(gh api user*) Bash(gh repo view *) Bash(gh pr create *)
---

# layered-review:init: 初期設定

引数: $ARGUMENTS

決まりの全体は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`。**アプリのコードは変えない。**

質問は必ず **AskUserQuestion** で出す。1 回に出すのは、答えが前の答えに依存しない質問だけ（最大 4 問）。選択肢をつけ、おすすめは先頭にして「(Recommended)」を付ける。**調べれば分かることは質問せず、自分で調べる。** 最初は厳しめにして、問題が起きないと分かってから緩める（逆は事故が起きてからになる）。

## 0. 準備

- 対象のリポジトリは `git rev-parse --show-toplevel`。以降 `<repo>`。
- `review/config.json` がすでにあれば作り直さない。`node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status <repo>` を見せ、`vendored_check` が `stale` なら `install` だけ実行して check.mjs を新しくし、終える。
- `git status -sb` を見る。まだコミットしていない変更があれば、それを伝えて続けてよいか尋ねる。

## 1. リポジトリを調べる

次を調べて、5〜10 行のメモにする（推測したことは推測と書く）。

- 構成：モノレポか、アプリ（Expo なら `app.json` / `app.config.*`・`eas.json`）と API（Hono なら `src/index.ts` の route、ミドルウェア）の場所
- 回せるチェック：`package.json` の scripts（`typecheck`・`lint`・`test`・`build`。workspaces ならそれぞれ）。パッケージマネージャーはロックファイルで決める
- 高リスクになりそうな場所：認証（`auth`・`session`・`middleware`）、課金（`billing`・`iap`・`purchase`・`revenuecat`）、DB（`migrations`・`schema`・`drizzle`・`prisma`）、リリース（`.github/workflows`・`eas.json`・`expo-updates` の設定）、権限（`app.json` の permissions）。`review/config.json` の既定（`${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs` の `DEFAULT_CONFIG`）に当たらないものを拾う
- 既にあるもの：`CLAUDE.md`・`REVIEW.md`・`.github/workflows/`・`.github/pull_request_template.md`・`CODEOWNERS`
- 何人で書いているか：`git shortlog -sne --since=90.days HEAD`（ボットを除く）。自分の GitHub のログイン名は `gh api user -q .login`
- feature-docs・observability を入れているか（`feature-docs/config.json`・`observability/`）

## 2. 決める

メモを見せてから、AskUserQuestion で次を聞く。

1. 体制：1 人（高リスクも作者が deep のレビューを自分で確かめる）/ 複数人（高リスクは作者以外の承認が要る）。直近の作者の数でおすすめを決める
2. 高リスクのパス：既定に、1 で見つけた場所を足す (Recommended) / 既定のまま / 自分で指定（Other で）
3. CI：`.github/workflows/layered-review.yml` を置く（PR ごとに形を調べ、リスク段階をジョブの要約に出す）(Recommended) / 置かない
4. PR テンプレート：置く（どう確かめたか・リスク・戻し方）(Recommended) / 置かない。すでにあれば「今のテンプレートに 3 項目を足す」を選択肢にする

## 3. 置く

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs install <repo> [--solo] [--ci] [--pr-template]
```

結果の `copied`・`skipped` を確かめる。PR テンプレートを足す場合は、既存のテンプレートに 3 項目を追記する（`${CLAUDE_PLUGIN_ROOT}/templates/ci/pull_request_template.md` を参考に）。

置いた `review/config.json` を、決めたことに合わせて直す。

- `checks`：1 で見つけたコマンド（例: `{"name": "typecheck", "run": "pnpm -r typecheck"}`）。遅いもの（E2E）は入れない
- `risk.high`：2 で決めたパスを、理由ごとに足す。理由の名前は人が読んで分かる言葉にする
- `risk.low`：feature-docs を使っていれば `features/**` はそのまま。生成物の置き場所があれば足す
- `approvals.trusted_authors`：自分のログイン名（複数人なら、このリポジトリを持つチームの人）

## 4. REVIEW.md を埋める

ひな形の 4 つの節を埋める。**短く保つ**（長いと、レビューのたびに読ませるコストと、守られない決まりが増える）。

- 「壊れた」とは：`docs/product/overview.md` などから分かればそれを使い、分からなければ 1 問だけ聞く（「利用者・お金・データで、絶対に起きてはいけないことは？」）
- 指摘しないこと：formatter と lint が入っていれば、その範囲は見ないと書く
- 見なくてよいパス：生成物・ロックファイル・スナップショット
- この領域で特に見ること：1 で分かった構成ごとに 2〜3 行（Hono なら入力の検証と route ごとの認可、Expo なら通信中・失敗・空の状態と秘密の値をバンドルに入れないこと、など）。思いつきで増やさない。同じ指摘がくり返し出たときに足す場所

## 5. CODEOWNERS（複数人のとき）

AskUserQuestion で「作る (Recommended) / 作らない」を聞き、作るなら持ち主（`@user` か `@org/team`）を聞く。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs codeowners <repo> --owner <@name>
```

`written: false`（もうある）なら、返ってきた `append` を見せて、末尾に足してよいか尋ねる。

## 6. CLAUDE.md に書く

ルートの `CLAUDE.md` に、次を足してよいか尋ねる（ないなら作る）。エージェントが PR の前に自分で確かめられるようにするため。

```markdown
## レビュー
決まりは REVIEW.md と review/README.md。PR を出す前に review/config.json の checks を回し、結果を見せる（「できました」ではなく）。
レビューは /layered-review:review。1 つの変更で回すのは review.max_rounds 回まで。
```

## 7. 確かめて PR にする

1. `node review/check.mjs` が通ることを確かめる。誤りがあれば直す。
2. 置いたものの一覧を見せ、AskUserQuestion で「PR を作る (Recommended) / コミットだけ / 止める」を聞く（引数に `--no-pr` があれば聞かずにコミットだけ）。
3. `git switch -c layered-review/init` でブランチを作ってコミットする。PR を作るなら `git push -u origin layered-review/init` のあと `gh pr create`。本文には、置いたもの、決めたこと、人がやること（下）を書く。

## 8. 人がやること

最後に、GitHub の設定でしかできないことを一覧で渡す（**このスキルでは設定しない**。リポジトリの設定を変えるため）。

- main のブランチ保護（Rulesets）：PR を必須にする、ステータスチェック（`layered-review` と既存の CI）を必須にする、**会話（レビューのスレッド）をすべて解決してからマージ**、**新しいコミットが積まれたら承認を取り消す**、（複数人なら）**Code Owners のレビューを必須**
- マージキュー（複数人で PR が多ければ）
- PR ごとの AI のレビューを CI でも回すなら：Claude Code の Code Review（Team / Enterprise。管理者が有効にする）か、Claude Code の GitHub Action。手元では `/layered-review:review <PR 番号>` で同じことができる

次の一歩を伝える：「PR の前に `/layered-review:review` を回せます。見逃したバグが見つかったら `/layered-review:eval add` でケースにしておくと、レビューの仕組みを変えたときに測れます」。
