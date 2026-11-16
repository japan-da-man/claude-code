---
name: retro
description: 人が始める振り返り。失敗した直後（同じセッションの会話を材料にする）か、原因キーを指定して（その原因の改善候補と事象メモを材料にする）、失敗票を起票し、原因を分類して、対策を 1 つだけ入れる（文章ルールは試用から、ガード・検証コマンド・Skill は差分の承認を通す）。エージェントを走らせ直す再現確認はしない。「いまの失敗を振り返って」「同じミスをしないようにして」「この原因に対策を入れて」「/self-improve:retro」と言われたときに使う。自動変更の確認は review を使う。
argument-hint: "[原因キー]"
allowed-tools: Bash(harness-note *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/test-guards.mjs *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs *) Bash(git rev-parse *) Bash(git status*) Bash(git diff*) Bash(git log*)
---

# self-improve:retro: 人が始める振り返り

引数: $ARGUMENTS

自動改善を待たずに、対策を入れたいときの振り返り。**失敗を再現するためにエージェントを走らせ直すことはしない。** 代わりに、失敗票を起票するときに証拠を確かめる。

`harness-note` が「ここでは使えません」と返したら（git リポジトリではない、除外してある）、その理由を伝えて終える。

`harness-note` が「--session を付けて呼んでください」と返したら（自動改善が別のセッションで実行中のとき）、`--session ${CLAUDE_SESSION_ID}` を付けて呼び直す。

質問は **AskUserQuestion** で出す（選択肢をつけ、おすすめを先頭に）。

先週の自動変更を確認したいときは、このスキルではなく `/self-improve:review`。

## 置き場所の考え方

**記録と、自分だけに効く対策は、user 側（`~/.claude/self-improve/` の下）に置く。チームに効かせる対策だけを、リポジトリに置く。** 共有リポジトリに、個人の失敗の記録を混ぜないため。

| もの | 置き場所 | 書く手段 |
| :- | :- | :- |
| 失敗票 | `~/.claude/self-improve/incidents/` | `harness-note incident add`（ファイルを直接は書かない） |
| 試用ルール | プラグインのデータ領域 | `harness-note trial add` |
| 自分専用のガード（全リポジトリ） | `~/.claude/self-improve/guards.json` | Write / Edit（確認が出る） |
| 自分専用のガード（このリポジトリだけ） | `~/.claude/self-improve/repos/<名前>/guards.json` | Write / Edit（確認が出る） |
| チームのガード | リポジトリの `harness/guards.json` | Write / Edit（確認が出る） |
| 検証コマンド | リポジトリの `harness/config.json` の `verify` | Write / Edit（確認が出る） |
| Skill | 自分専用は `~/.claude/skills/<リポジトリ名>-<名前>/`、チームは `.claude/skills/<名前>/` | Write（確認が出る） |

`<名前>` を含む実際のパスは、`harness-note status` の「リポジトリごとの置き場所」で分かる。**チームへ出すもの（リポジトリのファイル）には、失敗票 ID を書かない**（失敗票は、あなたの手元にしかないため）。

## 1. 材料を集める

- **引数がないとき（その場で振り返る）**：このセッションの会話がそのまま材料になる。何を頼まれ、何を期待され、実際に何をしたかを、会話から拾う。直近の事象メモは `harness-note episodes --recent 3` で読める。
- **原因キーがあるとき**：`harness-note list --key <原因キー> --status all` と `harness-note episodes <原因キー>` を読む。候補は LLM が書いた未検証の主張、事象メモはスクリプトが作った証拠。

どちらの場合も、`harness-note keys` で既存の原因キーを見せ、**同じ原因が既にないか**を尋ねる。同じ原因なら、そのキーを使う（似たキーを別々に持たない。まとめ直すなら `harness-note rekey <今のキー> <まとめ先>`）。このリポジトリの過去の失敗票は `harness-note incident list`（中身は `harness-note incident show <ID>`）。同じ `cause_key` の票は、起票のときに `related` へ自動で入る。

## 2. 原因を分類して、失敗票を起票する

**証拠を確かめる。** 事象メモやトランスクリプトに経緯が残っていれば、「実際の結果」がそれと合っているかを人に確かめてもらう。証拠が薄いもの（候補 1 件だけで、経緯が分からない）は、対策を入れず、記録だけ残す。

`root_cause` は次の 8 つから 1 つ。

| 原因 | 例 | 変換先 | 置き場所 |
| :- | :- | :- | :- |
| `knowledge` 規約や構成を知らない | ルートを違うディレクトリに作る | 文章ルール 1 行 | 試用（`harness-note trial add`）。昇格は `/self-improve:review` で、自分専用かチームへ |
| `procedure` 手順を飛ばす | マイグレーション生成を忘れる | 手順を Skill にする | 自分専用かチームの Skill（承認を通す） |
| `forbidden` やってはいけない操作 | 特定ディレクトリの手編集 | ガードの拒否パターン | 自分専用かチームのガード |
| `verification` 壊れたまま完了と報告 | 型エラーを残して終了 | 検証コマンド | `harness/config.json` の `verify` |
| `structure` 構造違反 | 層をまたぐ import、命名 | カスタム lint（検証コマンドから実行） | リポジトリのリンター設定 |
| `judgment` 判断の質 | 過剰設計、要件の取り違え | 仕様書への参照を促す文章ルール | 試用 |
| `environment` 環境やツールが原因 | 不安定なテスト | 環境を直す。ルールにしない | 対象外（`wontfix`） |
| `one_off` 再現しない | たまたまの誤り | 記録だけ残す | 対象外（`wontfix`） |

起票する（人だけの操作。ID は harness-note が振る。全リポジトリで 1 つの連番）。

```bash
harness-note incident add --key <原因キー> --root-cause <分類> --category <カテゴリ> \
  --asked '<何を頼んだか>' --expected '<期待した結果>' --actual '<実際の結果>' \
  --evidence '<根拠：セッション ID、事象メモ、コミット>'
```

- `--category` は改善候補のカテゴリ（`dev/mistake` など。同じ原因キーの候補があれば、省いてよい）。`--signal`（気づいたきっかけ：`tool_failure` / `human_correction` / `guard_denied` / `verify_failed` / `noticed`）、`--severity high`、`--area <backend など>` も付けられる。
- 対策を入れないと決めたもの（`environment`・`one_off`）は、`--status wontfix` を付けて起票し、ここで終える。
- どのリポジトリで起きたかと、リモートの URL（認証情報は取り除く）は、自動で記録される。
- 出力に、振られた ID（`INC-YYYY-NNNN`）が出る。以下、この ID を使う。
- 長い文は、`--actual -` のように `-` を指定して標準入力から渡せる（`<<'EOF'` の形。区切りは引用符で囲む）。

## 3. 対策を 1 つ提案する

- **1 つの失敗票につき、変換は 1 つ。** 複数を同時に足すと、どれが効いたか分からなくなる。
- **文章ルールは 1 回目から試用にしてよい。**
- **ガード・検証コマンド・Skill は、同じ `cause_key` が 2 回起きてから。** `forbidden` と `severity: high` だけは 1 回で足す。まだ 1 回目なら、文章ルールの試用にとどめるか、記録だけにする。
- **追記より置き換え。** 既存のルールを書き換えて済むなら、そうする。
- **足す前に矛盾を確かめる。** CLAUDE.md、`.claude/rules/`、`harness-note trial list`、自分専用のルール（`~/.claude/self-improve/repos/<名前>/rules.md`。あれば）を読み、矛盾する決まりがないかを見る。
- 同じ原因の文章ルールが既にあるのにまた起きたなら、文章を足さない。1 回目の再発は文言を直してよく、2 回目からはガードや検証コマンドへ移す。
- ガードと Skill は、**自分専用か、チームか**を尋ねる。おすすめは自分専用（ほかの人に影響しない。チームのリポジトリを変えない）。チームで同じ失敗が起きているなら、チーム。

提案を見せて、進めてよいか尋ねる。

## 4. 入れる

| 変換先 | やり方 |
| :- | :- |
| 文章ルール（試用） | `harness-note trial add --key <原因キー> --text '<命令形の 1 行>' --ref <INC-ID>`。次のセッション開始時から読み込まれる。続けて `harness-note incident set <INC-ID> --status trial --control trial:rules/<原因キー>`。試用ルールは、誰が入れたものでも、人が確認するまで「未確認」として数えられる（出力に変更 ID が出る）。この場で文言を見せて承認を得ているなら、続けて `harness-note review done <変更ID> --decision keep --incident <INC-ID>` で確認済みにする。承認を得ていなければ、そのままにする（次のセッション開始時に 1 行出て、`/self-improve:review` で確認できる） |
| ガード | 選んだ置き場所の `guards.json`（なければ `${CLAUDE_PLUGIN_ROOT}/templates/guards.json` をもとに作る）の `rules` に `{ "id", "pattern" または "path", "message" }` を足す。**message には直し方を 1 行**書く（例：`routes から db を直接 import しています。services/ 経由にしてください`）。同じ場所の `guards.test.json` に「止めるべき入力」と「止めてはいけない入力」を 1 件ずつ足し、`node ${CLAUDE_PLUGIN_ROOT}/scripts/test-guards.mjs` が通ることを確かめる。自分専用のガードの message には、失敗票 ID を付けてよい。チームのガード（`harness/guards.json`）には付けない |
| 検証コマンド | `harness/config.json` の `verify` に `{ "name", "run" }` を足す（ファイルがなければ `${CLAUDE_PLUGIN_ROOT}/templates/repo-config.json` をもとに作る。このファイルに書けるのは `verify` だけ）。足したら `harness-note verify trust --session ${CLAUDE_SESSION_ID}` で実行の許可を記録する（確認が出て、実行されるコマンドの一覧が表示される。許可していない中身は実行されない）。そのうえで、問題のある状態で `node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs` を 1 回実行し、実際に失敗することを見る |
| Skill | 自分専用は `~/.claude/skills/<リポジトリ名>-<名前>/SKILL.md`（description に、どのリポジトリの、どんな作業のときに使うかを書く）、チームは `.claude/skills/<名前>/SKILL.md` に手順を書く。スクリプト化は、人が承認してから |
| カスタム lint | リポジトリのリンター設定に足し、検証コマンドから実行されるようにする。エラー文に直し方を書く |

- ガード・検証コマンド・Skill・lint を足したら、失敗票を更新する：`harness-note incident set <INC-ID> --status converted --control <足した制御の場所>`。`control` は、リポジトリのファイルならリポジトリの根からのパス（`harness/guards.json` など）、user 側のファイルなら `personal:<パス>`（`personal:~/.claude/self-improve/repos/<名前>/guards.json` など）。
- user 側のファイル（`~/.claude/self-improve/` の下）と、リポジトリの `harness/config.json`・`guards.json`・`guards.test.json`、`.claude/rules/`、`.claude/skills/`、CLAUDE.md、リンター設定への書き込みには、確認が出る。差分を見て承認してもらう。
- 材料にした改善候補は、数え直されないようにする：`harness-note mark --key <原因キー> --status consumed`。
- 文章ルールの形は「命令形 1 行＋失敗票 ID」（例：`- ルート定義は src/routes/ に置く（INC-2026-0007）`）。ID は harness-note が付ける。
- `harness-note` は、ほかのコマンドで包まずに直接呼ぶ。引数の文は単一引用符（`'…'`）で囲む（変数の展開、`$(…)`、引用の外の `{ } * ? [ ] ~` が入っていると、ガードが断る）。
- 「見送り」と返ったら、従う。自動改善が実行中のあいだと、自動改善（`/self-improve:auto-improve`）を呼び出したセッションでは、失敗票の起票と更新、試用の追加・編集・削除、候補の採否、確認の結果の記録、昇格はできない。実行が終わってから、新しいセッションで行うよう伝える。

## 5. コミットする（リポジトリのファイルを変えたときだけ）

失敗票、試用ルール、自分専用のガードや Skill は、リポジトリの外にあるので、コミットするものはない。

チームのガード・検証コマンド・Skill・lint を足したときは、**1 変換に 1 コミット**（問題が出たら、そのコミットだけを revert できるように）。メッセージには、何を足したかを書く（例：`harness: 生成物の手編集を止めるガードを追加`）。失敗票 ID は書かない。コミットしてよいか尋ねてから行う。

最後に整合を確かめ、警告があれば伝える（止めない）。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs
```
