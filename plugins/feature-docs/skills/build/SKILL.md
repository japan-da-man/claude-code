---
name: build
description: 設計済み（designed）の要件定義書を実装する。統合ブランチ feature/REQ-xxxx を切り、設計書の未実装の節を小さなタスクに分け、タスクごとにテストを書いて実装し、テストの通った小さな PR を統合ブランチに自動でマージしていく。人を待たずに最後まで進め、終わったら /feature-docs:finalize に引き継ぐ。「REQ-xxxx を実装して」「/feature-docs:build REQ-xxxx」と言われたとき、設計の PR がマージされたあとに使う。
argument-hint: "<REQ-xxxx>"
model: opus
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(node feature-docs/check.mjs*) Bash(git fetch *) Bash(git status*) Bash(git rev-parse *) Bash(git remote get-url *) Bash(git switch *) Bash(git show *) Bash(git merge *) Bash(git pull *) Bash(git push *) Bash(git add *) Bash(git commit *) Bash(git diff*) Bash(git log *) Bash(gh pr *) Bash(gh api *) Bash(npm *) Bash(npx *) Bash(pnpm *) Bash(yarn *) Bash(bun *) Bash(maestro *) Bash(date *) Bash(sleep *) Bash(mkdir -p *)
---

# feature-docs:build: 設計から実装へ

対象: $ARGUMENTS

1. 準備 → 2. タスクに分ける → 3. タスクを 1 つずつ実装 → 4. 仕上げに引き継ぐ、の順に進める。決まりの全体は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`。

**ここは人の確認がない区間。** 人が見るのは最後の PR（統合ブランチ → main）だけなので、途中で承認を求めて止まらない。ただし、取り消せない操作（main への直接の push、データの削除、本番への反映）はしない。設計どおりに作れない・要件を満たせないと分かったら、勝手に要件を変えず、設計書の「実装メモ」に書いて先に進むか、進めないなら止めて伝える。

GitHub の操作（`gh pr …`・`gh issue view`）が `GitHub GraphQL is not available` で失敗したら、`${CLAUDE_PLUGIN_ROOT}/GITHUB.md` の REST の書き方に切り替える。

## 1. 準備

- 対象のリポジトリは `git rev-parse --show-toplevel`。引数がなければ `node feature-docs/check.mjs status` で `designed` のものを探す（複数なら AskUserQuestion で選ぶ）。
- `git fetch -q origin`。origin/main の要件定義書が `status: designed` で、設計書に `pending: [REQ-xxxx]` があることを確かめる。なければ設計の PR のマージを待つよう伝えて終える。
- 統合ブランチ `feature/REQ-xxxx`（`feature-docs/config.json` の `integration_branch_prefix` に従う）がなければ origin/main から作って push する。あれば switch して、origin/main を取り込む（`git merge origin/main`）。
- このリポジトリの確かめ方を調べる：`package.json` の scripts（`typecheck`・`lint`・`test` など）、モノレポなら各パッケージの scripts、`.maestro/`、EAS Workflows（`.eas/workflows/`）、`.github/workflows/`。CLAUDE.md に書いてあればそれに従う。
- 統合ブランチの守り：統合ブランチには、チェックを必須にするブランチ保護をかけない（main の取り込みや仕上げのコミットを直接 push するため）。チェックの合格は、このスキルが PR ごとに待って確かめる（3 の 5）。もし統合ブランチへの push が保護やルールセットで拒否されたら、そのコミットを短いブランチ（`feature/REQ-xxxx--sync-<n>` など）に載せて統合ブランチへの PR にし、チェックの合格を待ってマージする。

## 2. タスクに分ける

要件定義書と、`pending` に REQ-xxxx がある設計書の `> 未実装（REQ-xxxx）` の節を読み、**1 タスク = 1 PR** に分ける。

- 1 タスクは、レビューできる小ささ（目安 300 行以内の差分）で、それだけでテストが通るもの。
- 順番は依存の順：スキーマ・型 → API とデータ → アプリの状態とロジック → 画面 → 計測（tracking のイベント）→ E2E（Maestro のフロー）。
- 各タスクに、満たす受け入れ条件（設計書の「受け入れ条件」の項目）を対応させる。最後に、すべての受け入れ条件がどれかのタスクで満たされることを確かめる。
- タスクの一覧を TaskCreate で作る（人が進み具合を見られるように）。

## 3. タスクを 1 つずつ実装

タスクごとに次を繰り返す。

1. 統合ブランチから `feature/REQ-xxxx--<n>-<name>` を切る。
2. テストを先に書き、落ちることを確かめてから実装する（dev-flow プラグインがあれば `dev-flow:tdd` の進め方に従う）。UI は `docs/ui/REQ-xxxx/` の UI 案を「見た目と意図」として読み、design-system があればその部品とトークンで作る。
3. このリポジトリの確かめ方（型・lint・テスト）と `node feature-docs/check.mjs` をすべて通す。
4. コミットして push し、`gh pr create --base feature/REQ-xxxx --title "REQ-xxxx: <タスク>"`。本文に、満たす受け入れ条件と確かめた結果を書く。
5. チェックの合格を待ってから `gh pr merge <番号> --squash` でマージする（自動マージの予約は使わない。予約はすぐに戻ってくるので、マージ前に次のタスクを切ってしまう）。待ち方は `${CLAUDE_PLUGIN_ROOT}/GITHUB.md` の「チェックの合格を待つ」。落ちたら直して push する（3 回直しても通らなければ、原因を実装メモに書いて止め、伝える）。
6. PR が **マージされたこと**（`merged` が true）を確かめ、統合ブランチを pull してから次のタスクへ。
7. 3 タスクごとに、統合ブランチで `git merge origin/main` して **push する**（コンフリクトを最後まで溜めない。push しないと、次のタスクの PR に main の差分が混ざる）。

このあいだ、**要件定義書・機能マスタは変えない**。設計書は、設計から変えたことを「実装メモ」に書くときだけ変える。

## 4. 仕上げに引き継ぐ

すべてのタスクがマージされたら、統合ブランチで全部の確かめ方をもう一度通し、同じターンのまま `/feature-docs:finalize REQ-xxxx` の手順に進む（`${CLAUDE_PLUGIN_ROOT}/skills/finalize/SKILL.md`）。
