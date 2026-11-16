---
name: init
description: self-improve（自己改善ハーネス）の、user 単位の初期設定。user の設定（~/.claude/self-improve/config.json）を作り、harness-note コマンドの許可ルールを ~/.claude/settings.json に足し、止めたいリポジトリを除外に入れる。検証コマンドを使うと答えたときだけ、いまのリポジトリに harness/config.json を作る。「self-improve を入れて」「ハーネスを初期化して」「self-improve の設定をして」「このリポジトリでは self-improve を止めて」「/self-improve:init」と言われたときに使う。1 人につき 1 回でよい（self-improve は、init しなくても、すべての git リポジトリで動く）。
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs *) Bash(harness-note *) Bash(git rev-parse *) Bash(git status*)
---

# self-improve:init: user 単位の初期設定

self-improve は、プラグインを入れた時点から、**すべての git リポジトリで動いている**（失敗の記録、ガード、振り返り）。このスキルは、動かし始めるためのものではなく、設定を手元に置いて変えられるようにするためのもの。決まりの全体は `${CLAUDE_PLUGIN_ROOT}/DESIGN.md`、使い方は `${CLAUDE_PLUGIN_ROOT}/README.md`。**アプリのコードは変えない。リポジトリには、検証コマンドを使うと答えたときの `harness/config.json` のほかに、何も作らない。**

質問は **AskUserQuestion** で出す（選択肢をつけ、おすすめを先頭に）。

## 1. user の設定を置く

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs
```

結果の JSON を確かめる。`created` が作ったもの、`skipped` はすでにあったので触らなかったもの。2 回目以降の実行でも、既存のファイルは上書きしない。

| 作るもの | 中身 |
| :- | :- |
| `~/.claude/self-improve/config.json` | user の設定（全リポジトリに効く）。除外（`exclude`）は空、自動改善は止めてある（`auto.interval_days` が 0） |
| `~/.claude/self-improve/incidents/` | 失敗票の置き場所（全リポジトリの分） |

このスクリプトが書くのは、この 2 つだけ。下の 2〜4 は、Claude が、人の確認を通して書く。

## 2. harness-note の許可ルールを足す

`allow_rule_present` が false なら、`~/.claude/settings.json`（`settings_file`）の `permissions.allow` に `Bash(harness-note *)` を足す（ファイルがなければ作る。ほかの設定は消さない）。これがないと、改善候補を記録するたびに確認が出る。

- この書き込みには確認が出る。「`harness-note` コマンドを、どのリポジトリでも確認なしで実行できるようにする設定です」と伝えてから書く。
- 断られたら、足さずに進める（候補の記録のたびに確認が出ることを伝える）。

## 3. 検証コマンドを使うか尋ねる（いまのリポジトリ）

`repo` が null（git リポジトリの外）か、`repo.inactive` に理由が入っている（除外してある）なら、この手順は飛ばす。

`repo.verify_config_exists` が false なら、「このリポジトリで、ターンの終わりに検証コマンド（型チェックやリントなど）を走らせますか」と尋ねる。おすすめは「いまは使わない」（壊れたまま完了と報告する失敗が起きてから、`/self-improve:retro` で 1 行ずつ足せる）。

- **使う**：`repo.verify_template`（中身は `{ "verify": [] }`）をもとに、リポジトリの `harness/config.json` を作る。最初の検証コマンドを尋ね、あれば `verify` に `{ "name": "<名前>", "run": "<コマンド>" }` を足す。この書き込みには確認が出る。このファイルはリポジトリのファイルなので、コミットするかどうかも尋ねる（コミットすると、self-improve を入れているチームの全員に効く）。
- **使わない**：何も作らない。

リポジトリの `harness/config.json` から読むのは `verify` だけ。ほかの設定をここに書いても、読まれない。

## 4. 止めたい場所を尋ねる

「self-improve を止めたいリポジトリはありますか（例：顧客のリポジトリ、会社のルールで記録を残せない場所）」と尋ねる。あれば、`~/.claude/self-improve/config.json` の `exclude` に足す（確認が出る）。

- 書くのは、絶対パスか `~/` で始まるパス。そのパスと、その下にあるリポジトリが、すべて対象から外れる（`~/work/client-x` と書けば、その下の全リポジトリ）。
- 除外した場所では、何も記録せず、何も止めない（ガードも効かない）。
- ホームディレクトリそのもの（ホームを git で管理している場合）と、`node_modules` の中は、書かなくても外れている。
- `repo.inactive` に理由が入っていたら、いまのリポジトリが外れていることを伝える。

1 つのリポジトリだけ設定を変えたいとき（自動改善の間隔など）は、`repo.override_dir`（`~/.claude/self-improve/repos/<名前>/`）に `config.json` を置き、変えたい項目だけを書く。

## 5. 1.x から移る（名残があるときだけ）

`repo.legacy` に名残があれば、伝えて、移すかどうかを尋ねる。手順の詳細は README の「1.x からの移行」。

| 名残 | すること |
| :- | :- |
| `legacy.incidents` が 1 以上（`harness/incidents/` に失敗票がある） | `harness-note incident import` で user 側へ取り込む（番号がほかのリポジトリの票と重なれば、振り直される）。取り込んだ内容を確かめてから、`harness/incidents/` をリポジトリから消すかどうかを尋ねる |
| `legacy.config_keys` がある（`harness/config.json` に `verify` 以外の項目がある） | もう読まれない。全リポジトリで同じでよい値は `~/.claude/self-improve/config.json` へ、このリポジトリだけの値は `repo.override_dir` の `config.json` へ移し、`harness/config.json` からは消す（`verify` だけを残す。`verify` も空なら、ファイルごと消してよい） |
| `legacy.allow_rule` が true（`.claude/settings.local.json` に許可ルールがある） | 2 で user の設定に足したなら、要らない。消すかどうかを尋ねる（残しても害はない） |

リポジトリの `harness/guards.json` と `harness/guards.test.json` は、2.x でもそのまま効く（移さなくてよい）。

## 6. 動くことを確かめる

```bash
harness-note status
```

- リポジトリ名、データの置き場所、設定とガードの定義のファイルが表示されれば、準備はできている。
- 「ここでは使えません」と返ったら、その理由（git リポジトリではない、除外してある）を伝える。
- `command not found` のときは、プラグインの `bin/` がまだ PATH に入っていない。`/reload-plugins` か、Claude Code の起動し直しを頼む。
- 「データの置き場所」が「既定のパスの計算」と出たときは、セッション開始時の hook がまだ動いていない。次のセッションから引き渡される。
- 「警告：」の行が出たら、そこに書かれたファイルの書き間違いを直す（`~/.claude/self-improve/config.json` が読めないあいだは、ガードは効いたまま、記録と掃除が止まる）。「注意：」の行（`exclude` に書いたパスが見つからない、など）も伝える。

## 7. 伝える

最後に、次のことを短く伝える。

- すべての git リポジトリで、自動で起きること：ツールの失敗や訂正の記録、禁止操作（`git push --force`、`git commit --no-verify` など）の拒否、`.env` と、ハーネスのファイル（`~/.claude/self-improve/` の下、`~/.claude/CLAUDE.md`、リポジトリの `harness/`、`.claude/rules/`、CLAUDE.md など）を書き換えるときの確認、失敗の信号（ツールの失敗、訂正、ガードの拒否、検証の失敗）があったターンの終わりの「気づきがあれば記録する」確認。
- 失敗票、設定、自分専用のルールは、すべて `~/.claude/self-improve/` の下に置かれる。リポジトリには置かれない（チームのリポジトリに、個人の記録が混ざらない）。
- 自動改善はリポジトリごとで、止めてある。同じ原因の候補が、異なるセッションで 2 件たまると、セッション開始時に知らせる（`/self-improve:review` を開くか、知らせを閉じるまで。閉じなくても 7 日で出なくなる）。
- 止めたいリポジトリが増えたら、`exclude` に足す（またはこのスキルを呼ぶ）。その場だけ止めるなら `HARNESS_DISABLE=1 claude` で起動する。
