---
name: setup
description: goal-build をこのリポジトリで使えるように初期設定する（チェック用スクリプト、比較元ブランチ、一般品質レビュー用のエージェント、.gitignore、権限の提案）。リポジトリごとに 1 回。
disable-model-invocation: true
---

# goal-build: 初期設定

このリポジトリで goal-build（設計 → /goal で実装 → AI レビュー → PR の前で止めて報告）を使えるようにする。決めることは人に聞き、聞いた答えだけを書く。

## 手順

1. **jq を確かめる**：`command -v jq`。なければ入れ方（`brew install jq` / `apt-get install jq` など）を伝えて終える。goal-build のフックは jq を使う。
2. **git を確かめる**：`git rev-parse --show-toplevel` がこのプロジェクトのルートと同じか確かめる。違えば（モノレポの一部など）その旨を伝え、プロジェクトのルートで開き直すよう頼んで終える。
3. **チェックのコマンドを特定する**：`package.json`、`pyproject.toml`、`Makefile`、CI の設定、CLAUDE.md から、テスト・型チェック・lint のコマンドを TypeScript と Python のそれぞれについて探す。見つからないもの、複数の候補があるものは AskUserQuestion でまとめて聞く。
4. **`.goal-build/check.sh` を作る**：次の形にして `chmod +x` する。どれか 1 つでも失敗したら全体が失敗する。

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   cd "$(git rev-parse --show-toplevel)"
   pnpm tsc --noEmit
   pnpm vitest run
   uv run pyright
   uv run pytest -q
   ```

5. **`.goal-build/config` を作る**：比較元ブランチを聞いて書く（既定は `origin/main`）。一般品質のレビューに使うエージェントを聞き、使うなら `REVIEW_AGENT` に名前（例：`dev-flow:reviewer`）を書く。使わないなら空にする。

   ```text
   BASE_BRANCH=origin/main
   REVIEW_AGENT=
   ```

6. **比較元でチェックが通るか確かめる**：`git stash` などで手元の変更を退避させずに済むよう、いまのブランチが比較元と同じ内容のときだけ `./.goal-build/check.sh` を実行する。違うときは実行せず「比較元で通ることを確かめてください」と伝える。失敗した場合は、直すか check.sh の対象を絞るよう伝えて終える（元から落ちるチェックがあると、実装のたびに止まってしまう）。
7. **`.gitignore`**：次の 3 行がなければ足す。`docs/specs/` がなければ作る。

   ```text
   .goal-build/*
   !.goal-build/check.sh
   !.goal-build/config
   ```

8. **権限を提案する**：次の 2 つを見せ、入れるかどうかと、書き込み先（チーム共有の `.claude/settings.json` か、自分だけの `.claude/settings.local.json`）を AskUserQuestion で聞く。答えに従って書き足す（既存の設定は消さない）。
   - PR の作成とマージを常に止めたい場合の deny（フックは `gh api` 経由などを防げないため）：
     `"deny": ["Bash(gh pr create *)", "Bash(gh pr merge *)", "Read(./.env)", "Read(./.env.*)"]`
   - auto モードが使えない環境で、/goal が承認待ちで止まらないようにする allow（`claude --permission-mode acceptEdits` での起動と組み合わせる）：
     `"allow": ["Bash(./.goal-build/check.sh)", "Bash(git add *)", "Bash(git commit *)", "Bash(git diff *)", "Bash(git merge-base *)", "Bash(git fetch *)", "Bash(git rev-parse *)", "Bash(git log *)", "Bash(git status *)", "Bash(git switch *)", "Bash(git checkout -b *)", "Bash(mkdir *)"]` と、手順 3 で見つけたコマンド（`Bash(pnpm *)`、`Bash(uv run *)` など）
9. **まとめ**：作ったファイルと、次の使い方を短く伝える。`check.sh` と `config` はコミットしてよいことも伝える（コミットはしない）。

   ```text
   /goal-build:design <feature> <要件定義書のパス>
   ```
