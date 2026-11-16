---
name: init
description: リポジトリで self-improve（自己改善ハーネス）を使えるようにする初期設定。harness/config.json・guards.json・guards.test.json・incidents/ を作り、harness-note コマンドの許可ルールを .claude/settings.local.json に足す。「self-improve を入れて」「ハーネスを初期化して」「/self-improve:init」と言われたとき、ほかの self-improve のスキルで harness/config.json がないと言われたときに使う。リポジトリごとに 1 回。
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs *) Bash(harness-note *) Bash(git rev-parse *) Bash(git status*)
---

# self-improve:init: 初期設定

このリポジトリで、失敗の記録・ガード・検証・振り返りが動くようにする。決まりの全体は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`、使い方は `${CLAUDE_PLUGIN_ROOT}/README.md`。**アプリのコードは変えない。**

`harness/config.json` がないリポジトリでは、このプラグインの hook はすべて何もしない。このスキルがそのファイルを作った時点から、hook が動き始める。

## 1. 置く

対象のリポジトリは `git rev-parse --show-toplevel`（git リポジトリでなければ、その旨を伝えて終える）。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs <repo>
```

結果の JSON を確かめる。`created` が作ったもの、`skipped` はすでにあったので触らなかったもの。2 回目以降の実行でも、既存のファイルは上書きしない。

| 作るもの | 中身 |
| :- | :- |
| `harness/config.json` | 設定のすべて。自動改善は止めてある（`auto.interval_days` が 0）、検証コマンド（`verify`）は空 |
| `harness/guards.json` | このリポジトリだけの禁止操作（最初は空）。共通の禁止リストはプラグインが持っている |
| `harness/guards.test.json` | ガードのテストケース（最初は空） |
| `harness/incidents/` | 失敗票の置き場所 |
| `.gitignore` への追記 | `harness/reports/` |

## 2. harness-note の許可ルールを足す

`allow_rule_present` が false なら、`.claude/settings.local.json` の `permissions.allow` に `Bash(harness-note *)` を足す（ファイルがなければ作る。ほかの設定は消さない）。これがないと、改善候補を記録するたびに確認が出る。

- この書き込みには確認が出る。「`harness-note` コマンドを確認なしで実行できるようにする設定です」と伝えてから書く。
- 断られたら、足さずに進める（候補の記録のたびに確認が出ることを伝える）。

## 3. 動くことを確かめる

```bash
harness-note status
```

- リポジトリ名、データの置き場所、セッションが表示されれば、準備はできている。
- `command not found` のときは、プラグインの `bin/` がまだ PATH に入っていない。`/reload-plugins` か、Claude Code の起動し直しを頼む。
- 「データの置き場所」が「既定のパスの計算」と出たときは、セッション開始時の hook がまだ動いていない。次のセッションから引き渡される。

## 4. 伝える

最後に、次のことを短く伝える。

- これから自動で起きること：ツールの失敗や訂正の記録、禁止操作（`git push --force`、`git commit --no-verify` など）の拒否、`.env` と、ハーネスのファイル（`harness/config.json`、`.claude/rules/`、CLAUDE.md など）を書き換えるときの確認、変更や信号があったターンの終わりの「気づきがあれば記録する」確認。
- 検証コマンドは空で始める。「壊れたまま完了と報告した」失敗が起きたときに、`/self-improve:retro` で 1 行ずつ足す。
- 自動改善は止めてある。同じ原因の候補が、異なるセッションで 2 件たまると、セッション開始時に知らせる（`/self-improve:review` を開くか、知らせを閉じるまで。閉じなくても 7 日で出なくなる）。
- 邪魔になったら `HARNESS_DISABLE=1 claude` で起動すれば、hook がすべて止まる。
- `harness/` はコミットしておく（`.claude/settings.local.json` は git の管理外）。コミットしてよいか尋ね、よければ `harness/` と `.gitignore` だけをコミットする。
