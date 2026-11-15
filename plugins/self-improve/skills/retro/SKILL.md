---
name: retro
description: 人が始める振り返り。失敗した直後（同じセッションの会話を材料にする）か、原因キーを指定して（その原因の改善候補と事象メモを材料にする）、失敗票を書き、原因を分類して、対策を 1 つだけ入れる（文章ルールは試用から、ガード・検証コマンド・Skill は差分の承認を通す）。エージェントを走らせ直す再現確認はしない。「いまの失敗を振り返って」「同じミスをしないようにして」「この原因に対策を入れて」「/self-improve:retro」と言われたときに使う。自動変更の確認は review を使う。
argument-hint: "[原因キー]"
allowed-tools: Bash(harness-note *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/test-guards.mjs *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs *) Bash(git rev-parse *) Bash(git status*) Bash(git diff*) Bash(git log*)
---

# self-improve:retro: 人が始める振り返り

引数: $ARGUMENTS

自動改善を待たずに、対策を入れたいときの振り返り。**失敗を再現するためにエージェントを走らせ直すことはしない。** 代わりに、失敗票を作るときに証拠を確かめる。

`harness/config.json` がなければ、`/self-improve:init` を勧めて終える。

`harness-note` が「--session を付けて呼んでください」と返したら（自動改善が別のセッションで実行中のとき）、`--session ${CLAUDE_SESSION_ID}` を付けて呼び直す。

質問は **AskUserQuestion** で出す（選択肢をつけ、おすすめを先頭に）。

先週の自動変更を確認したいときは、このスキルではなく `/self-improve:review`。

## 1. 材料を集める

- **引数がないとき（その場で振り返る）**：このセッションの会話がそのまま材料になる。何を頼まれ、何を期待され、実際に何をしたかを、会話から拾う。直近の事象メモは `harness-note episodes --recent 3` で読める。
- **原因キーがあるとき**：`harness-note list --key <原因キー> --status all` と `harness-note episodes <原因キー>` を読む。候補は LLM が書いた未検証の主張、事象メモはスクリプトが作った証拠。

どちらの場合も、`harness-note keys` で既存の原因キーを見せ、**同じ原因が既にないか**を尋ねる。同じ原因なら、そのキーを使う（似たキーを別々に持たない。まとめ直すなら `harness-note rekey <今のキー> <まとめ先>`）。`harness/incidents/` に同じ `cause_key` の失敗票があれば、`related` でつなぐ。

## 2. 失敗票を書く

`${CLAUDE_PLUGIN_ROOT}/templates/incident.md` をもとに、`harness/incidents/INC-YYYY-NNNN.md` を作る。番号は、その年の続き番号（`harness/incidents/` を見て決める。`harness-note review` の `next_incident_id` でも分かる）。

- 本文は 4 見出し：「何を頼んだか」「期待した結果」「実際の結果」「根拠（セッション ID、事象メモ、コミット）」。
- **証拠を確かめる。** 事象メモやトランスクリプトに経緯が残っていれば、「実際の結果」がそれと合っているかを人に確かめてもらう。証拠が薄いもの（候補 1 件だけで、経緯が分からない）は、対策を入れず、記録だけ残す（`status: open`）。
- `root_cause` は次の 8 つから 1 つ。`category` は改善候補のカテゴリ、`signal` は気づいたきっかけ。

| 原因 | 例 | 変換先 | 置き場所 |
| :- | :- | :- | :- |
| `knowledge` 規約や構成を知らない | ルートを違うディレクトリに作る | 文章ルール 1 行 | 試用（`harness-note trial add`）。昇格後は `.claude/rules/`（paths 付き） |
| `procedure` 手順を飛ばす | マイグレーション生成を忘れる | 手順を Skill にする | `.claude/skills/<名前>/`（承認を通す） |
| `forbidden` やってはいけない操作 | 特定ディレクトリの手編集 | ガードの拒否パターン | `harness/guards.json` |
| `verification` 壊れたまま完了と報告 | 型エラーを残して終了 | 検証コマンド | `harness/config.json` の `verify` |
| `structure` 構造違反 | 層をまたぐ import、命名 | カスタム lint（検証コマンドから実行） | リポジトリのリンター設定 |
| `judgment` 判断の質 | 過剰設計、要件の取り違え | 仕様書への参照を促す文章ルール | 試用 |
| `environment` 環境やツールが原因 | 不安定なテスト | 環境を直す。ルールにしない | 対象外（`wontfix`） |
| `one_off` 再現しない | たまたまの誤り | 記録だけ残す | 対象外（`wontfix`） |

失敗票そのもの（`harness/incidents/`）は、確認なしで書いてよい。

## 3. 対策を 1 つ提案する

- **1 つの失敗票につき、変換は 1 つ。** 複数を同時に足すと、どれが効いたか分からなくなる。
- **文章ルールは 1 回目から試用にしてよい。**
- **ガード・検証コマンド・Skill は、同じ `cause_key` が 2 回起きてから。** `forbidden` と `severity: high` だけは 1 回で足す。まだ 1 回目なら、文章ルールの試用にとどめるか、記録だけにする。
- **追記より置き換え。** 既存のルールを書き換えて済むなら、そうする。
- **足す前に矛盾を確かめる。** CLAUDE.md、`.claude/rules/`、`harness-note trial list` を読み、矛盾する決まりがないかを見る。
- 同じ原因の文章ルールが既にあるのにまた起きたなら、文章を足さない。1 回目の再発は文言を直してよく、2 回目からはガードや検証コマンドへ移す。

提案を見せて、進めてよいか尋ねる。

## 4. 入れる

| 変換先 | やり方 |
| :- | :- |
| 文章ルール（試用） | `harness-note trial add --key <原因キー> --text "<命令形の 1 行>" --ref INC-YYYY-NNNN`。リポジトリの外（プラグインのデータ領域）に置かれ、次のセッション開始時から読み込まれる。失敗票は `status: trial`、`control: trial:rules/<原因キー>`、`applied_by: human`、`trial_started_at` に今日 |
| ガード | `harness/guards.json` の `rules` に `{ "id", "pattern" または "path", "message" }` を足す。**message には直し方を 1 行**書く（例：`routes から db を直接 import しています。services/ 経由にしてください（INC-2026-0012）`）。`harness/guards.test.json` に「止めるべき入力」と「止めてはいけない入力」を 1 件ずつ足し、`node ${CLAUDE_PLUGIN_ROOT}/scripts/test-guards.mjs <repo>` が通ることを確かめる |
| 検証コマンド | `harness/config.json` の `verify` に `{ "name", "run" }` を足す。足す前に、問題のある状態で `node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs <repo>` を 1 回実行し、実際に失敗することを見る |
| Skill | `.claude/skills/<名前>/SKILL.md` に手順を書く。スクリプト化は、人が承認してから |
| カスタム lint | リポジトリのリンター設定に足し、検証コマンドから実行されるようにする。エラー文に直し方と失敗票 ID を書く |
| `environment` / `one_off` | 何も足さない。失敗票を `status: wontfix` にする |

- `harness/config.json`、`guards.json`、`guards.test.json`、`.claude/rules/`、`.claude/skills/`、CLAUDE.md、リンター設定への書き込みには、確認が出る（ガードが必ず出す）。差分を見て承認してもらう。
- ガード・検証コマンド・Skill を足したら、失敗票を `status: converted`、`control` に足した制御のパスにする。
- 材料にした改善候補は、数え直されないようにする：`harness-note mark --key <原因キー> --status consumed`。
- 文章ルールの形は「命令形 1 行＋失敗票 ID」（例：`- ルート定義は src/routes/ に置く（INC-2026-0007）`）。ID は harness-note が付ける。

## 5. コミットする

**1 変換に 1 コミット。** メッセージに失敗票 ID を入れる（例：`harness(INC-2026-0007): ルートの置き場所を追加`）。問題が出たら、そのコミットだけを revert できるようにするため。コミットしてよいか尋ねてから行う。試用ルールはリポジトリの外にあるので、コミットに入るのは失敗票だけ。

最後に整合を確かめ、警告があれば伝える（止めない）。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs <repo>
```
