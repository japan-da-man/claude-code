---
name: init
description: アプリのリポジトリで feature-docs を使えるようにする初期設定。要件定義書・設計書・機能マスタの置き場所と設定、整合のチェッカー（feature-docs/check.mjs）、プロダクト要件・アクター・用語のひな形、CI と PR テンプレートを置く。「feature-docs を入れて」「要件と機能マスタを管理できるようにして」「/feature-docs:init」と言われたとき、ほかの feature-docs のスキルで設定がないと言われたときに使う。リポジトリごとに 1 回。
argument-hint: "[--no-pr]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(node feature-docs/check.mjs*) Bash(git fetch *) Bash(git status*) Bash(git rev-parse *) Bash(git switch *) Bash(git add *) Bash(git commit *) Bash(git diff*) Bash(gh auth status*) Bash(git remote get-url *) Bash(git push *) Bash(gh pr *) Bash(gh api *)
---

# feature-docs:init: 初期設定

引数: $ARGUMENTS

このリポジトリで、企画から公開までの成果物を 3 つに分けて管理できるようにする。決まりの全体は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`。**アプリのコードは変えない。**

質問は必ず **AskUserQuestion** で出す。1 回に出すのは、答えが前の答えに依存しない質問だけ（最大 4 問）。選択肢をつけ、おすすめは先頭にして「(Recommended)」を付ける。**調べれば分かることは質問せず、自分で調べる。**

GitHub の操作（`gh pr …`・`gh issue view`）が `GitHub GraphQL is not available` で失敗したら、`${CLAUDE_PLUGIN_ROOT}/GITHUB.md` の REST の書き方に切り替える。

## 0. 準備

- 対象のリポジトリは `git rev-parse --show-toplevel`。以降のコマンドはすべてそのパスで実行する。
- `feature-docs/config.json` がすでにあれば、作り直さない。`node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status <repo>` を見せ、`vendored_check` が `stale` なら `install` だけ実行して check.mjs を新しくし、終える。
- `git fetch -q origin` のあと `git status -sb` を見る。まだコミットしていない変更があれば、それを伝えて続けてよいか尋ねる。

## 1. リポジトリを調べる

次を調べて、5〜10 行のメモにする（推測したことは推測と書く）。

- 構成：モノレポか（アプリと API が同じリポジトリか）。`package.json` の workspaces、`apps/`・`packages/` など
- アプリの種類とバージョンの場所（Expo なら `app.json` / `app.config.*` の `expo.version`）
- 既にある文書：`docs/`、`CLAUDE.md`、spec-flow の `docs/specs/`、design-system の `design-system/`
- 既にある機能のおおよその一覧（画面のルート、主なタブ）。後で機能マスタに起こすかどうかの判断に使う
- `.github/workflows/` と `.github/pull_request_template.md` があるか
- `gh auth status` で PR を作れるか

## 2. 決める

メモを見せてから、AskUserQuestion で次を聞く。

1. 置き場所：既定のまま（`docs/requirements`・`docs/design`・`docs/ui`・`features`・`actors.yaml`・`glossary.yaml`）(Recommended) / 変える（Other で）
2. CI：`.github/workflows/feature-docs.yml` を置く（PR ごとにチェック、main で ヘルプ用ナレッジを書き出す）(Recommended) / 置かない
3. PR テンプレート：置く（変更理由・影響する機能 ID・利用者への影響）(Recommended) / 置かない。すでにあれば「今のテンプレートに 3 項目を足す」を選択肢にする
4. 今ある機能：あとで少しずつ機能マスタに起こす (Recommended) / 今ここで主な機能を `legacy: true` で起こす

置き場所を変えるなら、`feature-docs/config.json` の `paths` に書く（キーは `${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs` の `DEFAULT_CONFIG` のとおり）。

## 3. 置く

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs install <repo> [--ci] [--pr-template]
```

結果の `copied`・`skipped`・`created_dirs` を確かめる。PR テンプレートを足す場合は、既存のテンプレートに 3 項目を追記する（`${CLAUDE_PLUGIN_ROOT}/templates/ci/pull_request_template.md` を参考に）。

## 4. 共通のことを埋める

置いたひな形のうち、次を短い一問一答で埋める（1 で分かったことは聞かない）。

- `docs/product/overview.md`：なぜ作るか、誰のためか、全体の KPI、対応する OS、スコープ外
- `actors.yaml`：登場人物（人と、通知・決済などのシステム）。id は `A-<英小文字>`（人）、`S-<英小文字>`（システム）
- `glossary.yaml`：取り違えやすい用語があれば。ヘルプ AI に出してよい用語は `public: true`

`docs/architecture/overview.md` は、1 で分かった構成で flowchart を書き直す（Mermaid の C4 の書き方は GitHub で表示されないので使わない）。

## 5. 今ある機能を起こす（4 で選んだときだけ）

主な機能ごとに `${CLAUDE_PLUGIN_ROOT}/templates/feature.yaml` から `features/F-xxx-<name>.yaml` を作る。番号は `node feature-docs/check.mjs next-id feature` で取り、1 つ作るたびに取り直す。

- `legacy: true` を付け、`requirements` は書かない。
- 書くのは **利用者から見た事実だけ**（画面で確かめられること）。API やデータの持ち方は書かない。
- ヘルプの項目まで書けないものは `status: beta` にしておく（`ga` はヘルプの項目が必須）。
- アプリが大きければ、Explore のサブエージェントに画面ごとに調べさせてよい。

## 6. CLAUDE.md に書く

ルートの `CLAUDE.md` に、次の 3 行を足してよいか尋ねる（ないなら作る）。エージェントが決まりを読めるようにするため。

```markdown
## 要件・設計・機能マスタ
決まりは feature-docs/README.md。要件定義書は docs/requirements/、設計書は docs/design/、機能マスタは features/。
機能マスタには利用者から見た事実だけを書き、`node feature-docs/check.mjs` が通ることを確かめる。
```

## 7. 確かめて PR にする

1. `node feature-docs/check.mjs` が通ることを確かめる。誤りがあれば直す。
2. 置いたものの一覧を見せ、AskUserQuestion で「PR を作る (Recommended) / コミットだけ / 止める」を聞く（引数に `--no-pr` があれば聞かずにコミットだけ）。
3. `git switch -c feature-docs/init` でブランチを作ってコミットする。PR を作るなら `git push -u origin feature-docs/init` のあと `gh pr create`。本文には、置いたもの、決めたこと、次の一歩を書く。

最後に、次の一歩を伝える：「企画ができたら `/feature-docs:requirements <やりたいこと>` で要件定義を始められます」。
