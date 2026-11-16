---
name: review
description: 自動改善が入れた未確認の変更（試用ルール、試用 Skill、承認待ちの案、対策を入れなかった記録）を 1 件ずつ見せ、「残す／直す／消す／昇格する（自分専用かチームへ）」を人に選んでもらって反映する。あわせて、見直しの時期が来た試用、バグの候補、重なった好みの候補も確認する。セッション開始時に「自動改善（…）」「未確認の自動変更 N 件」「重なった好みの候補」と出たとき、「自動変更を確認して」「試用ルールを見せて」「改善候補を見せて」「試用を昇格して」「/self-improve:review」と言われたときに使う。
allowed-tools: Bash(harness-note *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/test-guards.mjs *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs *) Bash(git rev-parse *) Bash(git status*) Bash(git diff*) Bash(git log*)
---

# self-improve:review: 自動変更を 1 件ずつ確認する

自動改善は、人が証拠を見る前に試用を効かせている。ここで人が中身を見て、定着させるかどうかを決める。**決めるのは人。** 選択は **AskUserQuestion** で 1 件ずつ尋ね、まとめて承認させない。

`harness-note` が「ここでは使えません」と返したら（git リポジトリではない、除外してある）、その理由を伝えて終える。

`harness-note` が「--session を付けて呼んでください」と返したら（自動改善が別のセッションで実行中のとき）、`--session ${CLAUDE_SESSION_ID}` を付けて呼び直す。`--session` に付けられるのは、このセッションの ID だけ（ほかの値は、ガードが拒否する）。

自動改善を呼び出したセッション（`/self-improve:auto-improve` を実行したセッション）では、確認の結果を記録できず、知らせも閉じない（`harness-note` が「見送り」と返す）。確認は、別のセッションで行う。自動改善が実行中のあいだも同じで、実行が終わってから行う。

`harness-note` は、ほかのコマンドで包まずに直接呼ぶ。引数の文は単一引用符（`'…'`）で囲む（変数の展開、`$(…)`、引用の外の `{ } * ? [ ] ~` が入っていると、ガードが断る）。

## 1. 一覧を取る

```bash
harness-note review
```

JSON が返る。

| 項目 | 中身 |
| :- | :- |
| `unreviewed` | 未確認の自動変更。`kind` は `trial_add`（試用ルールの追加）・`trial_edit`（再発による編集）・`skill_add`（試用 Skill）・`proposal`（承認待ちの案）・`draft`（対策を入れなかった記録）。`rule`・`skill` に中身、`draft` に失敗票の下書き。`manual: true` は、自動改善の実行の外で（`harness-note trial add` / `edit` で）入った試用ルール。誰が入れたものでも、ここで確認するまで未確認として数える |
| `stale_trials` | 置いてから見直しの日数（初期値 60 日）を超えた試用 |
| `bugs` | バグの候補（`dev/bug`） |
| `preferences` | 3 セッション以上で重なった好みの候補。**全リポジトリの分**を数えたもの（好みは、リポジトリではなく、あなたに付く） |
| `other_drafts` | 未確認の変更に結び付いていない下書き |
| `auto_blocked` | 自動改善が、いま試用を追加していない理由（未確認の上限、試用の件数、self-improve が読み込ませるルールの行数）。空なら、止まっていない |
| `promoted` | 自分専用かチームへ昇格済みのもの（参考。確認の対象ではない） |

一覧を取ると、セッション開始時の知らせ（自動改善の報告の 1 行、「有効にしますか」、重なった好みの候補など）は閉じられ、次のセッションからは出ない。未確認の件数の 1 行は、確認が済むまで出る。一覧を見ずに知らせだけ閉じたいと頼まれたら、`harness-note report close` を実行する。どちらも、どのセッションからの操作かを確かめられないとき（「--session <セッションID> の形で呼んでください」と返る）は閉じないので、`--session ${CLAUDE_SESSION_ID}` を付けて呼び直す。

`auto_blocked` に理由があれば、最初に伝える（確認・昇格を進めるか、ルールを減らすと、また追加するようになる）。

何もなければ「確認するものはありません」と伝えて終える。経緯を読みたいときは `harness-note report show`（直近の実行の記録）、`harness-note episodes <原因キー>`（事象メモ）。

## 2. 未確認の自動変更を 1 件ずつ

1 件ごとに、次を見せてから尋ねる。

- 何が入ったか（試用ルールの 1 行、Skill の全文、案の中身）。`trial_edit` なら、直す前の文言（`rule.previous`）も
- 根拠（下書きの「実際の結果」と「根拠」）。事象メモがあれば、内容が合っているかを確かめてもらう
- 置いてからの日数、同じ原因がまた出ているか
- `note` が付いていれば、そのまま伝える（自動改善の実行の外で入った試用ルール。入れた覚えがあるかを尋ね、なければ中身をよく見てもらう）

**失敗票は、ファイルを直接は書かない。** 下書き（`draft`）があるものは、次のコマンドで起票する。下書きに入っている値（`status: trial`、`control`、原因の分類、試用を始めた日）は、そのまま引き継がれ、下書きは捨てられる。出力に、振られた ID（`INC-YYYY-NNNN`）が出る。

```bash
harness-note incident add --from-draft --key <原因キー>
```

### 試用ルール・試用 Skill（`trial_add` / `trial_edit` / `skill_add`）

| 選ぶもの | すること |
| :- | :- |
| 残す | 下書きから起票し、`harness-note review done <変更ID> --decision keep --incident <INC-ID>`（試用ルールに、失敗票 ID が付く） |
| 直す | 文言を尋ね、`harness-note trial edit --key <原因キー> --text '<直した 1 行>'`。あとは「残す」と同じで、`--decision edit` で記録する。Skill を直したいときは、自分専用に昇格してから直す（試用のあいだは、harness-note 以外から書けない） |
| 消す | `harness-note review done <変更ID> --decision remove`。試用を消し、下書きを捨て、その原因を「断られた」と記録する（新しい候補が 2 件たまるまで、自動改善の対象から外れる）。同じ内容が Claude Code の自動メモリに残っていることがあるので、`/memory` も確かめるよう伝える |
| 昇格する | 下の「昇格」のとおりに、自分専用かチームへ |

何も選ばなければ、試用のまま効き続ける（未確認が上限に達すると、自動改善は新しい追加をやめる）。

### 承認待ちの案（`proposal`、または `proposal: true` の付いた試用）

下書きの「承認待ちの案」を見せる。ガード、検証コマンド、git 管理下のファイルの編集のどれか。

- **承認**：案を反映する。
  - ガード：自分専用か、チームかを尋ねる（おすすめは自分専用）。自分専用は `~/.claude/self-improve/repos/<名前>/guards.json`（全リポジトリに効かせるなら `~/.claude/self-improve/guards.json`）、チームはリポジトリの `harness/guards.json`。ファイルがなければ `${CLAUDE_PLUGIN_ROOT}/templates/guards.json` をもとに作る。同じ場所の `guards.test.json` に「止めるべき入力」と「止めてはいけない入力」を 1 件ずつ足して、`node ${CLAUDE_PLUGIN_ROOT}/scripts/test-guards.mjs` を通す。`<名前>` を含む実際のパスは、`harness-note status` の「リポジトリごとの置き場所」。
  - 検証コマンド：リポジトリの `harness/config.json` の `verify` に足し（なければ `${CLAUDE_PLUGIN_ROOT}/templates/repo-config.json` をもとに作る）、`harness-note verify trust --session ${CLAUDE_SESSION_ID}` で実行の許可を記録する（確認が出て、実行されるコマンドの一覧が表示される。許可していない中身は実行されない）。そのうえで、問題のある状態で `node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs` が失敗することを見る。
  - 起票して、記録する：`harness-note incident add --from-draft --key <原因キー> --status converted --control <足した制御の場所>`、続けて `harness-note review done <変更ID> --decision apply --incident <INC-ID>`。`control` は、リポジトリのファイルならリポジトリの根からのパス、user 側のファイルなら `personal:<パス>`。
- **却下**：`harness-note review done <変更ID> --decision dismiss`（下書きを捨て、その原因を「断られた」と記録する）。

これらの書き込みには、確認が出る（user 側のファイルも、リポジトリの `harness/` も）。**チームへ出すもの（リポジトリのファイル）には、失敗票 ID を書かない。**

### 対策を入れなかった記録（`draft`）

自動改善が「環境が原因」「再現しない」などと判断して、記録だけ残したもの。

- **記録として残す**：`harness-note incident add --from-draft --key <原因キー> --status wontfix`、続けて `--decision keep --incident <INC-ID>`。
- **捨てる**：`--decision dismiss`。
- 判断が違う（対策を入れたい）ときは、記録として残してから `/self-improve:retro <原因キー>` を勧める。

## 3. 昇格

昇格は日数で自動判定しない。判断の材料は、置いてからの日数と、同じ原因がまた出たかどうか。未確認の試用も、見直しの時期が来た試用も、確認済みの試用も、同じコマンドで昇格できる（昇格すると、確認済みにもなる）。

まず、**自分専用か、チームか**を尋ねる。

| 行き先 | 向いているもの | 置き場所 |
| :- | :- | :- |
| 自分専用（おすすめ） | 自分の作業のしかたに関わるもの。チームで合意していないもの。共有リポジトリを変えたくないとき | ルールは `~/.claude/self-improve/repos/<名前>/rules.md`（このリポジトリのセッション開始時に読み込まれる）。Skill は、いまの場所（`~/.claude/skills/<リポジトリ名>-<名前>/`）のまま |
| チーム | チームの全員に効かせたい規約。レビューを通して合意するもの | リポジトリの `.claude/rules/`、`.claude/skills/` |

下書きが残っていれば、先に `harness-note incident add --from-draft --key <原因キー>` で起票しておく（失敗票が `converted` になり、`control` に行き先が入る）。

### 自分専用へ

```bash
harness-note promote --key <原因キー> --to personal --incident <INC-ID>
```

- 試用ルールは、自分専用のルールに 1 行足され、試用からは消える。次のセッションからも、同じように読み込まれる。
- 試用 Skill は、置き場所も中身も変わらず、試用ではなくなる。これ以降は、ふつうのファイルとして直せる（`~/.claude` の下なので、書き込みには確認が出る）。
- リポジトリには、何も書かれない。コミットするものもない。
- `--incident` は、失敗票があるときだけ付ける（試用ルールに失敗票 ID が付いていれば、省いても、その票が更新される）。

### チームへ

1. リポジトリの `.claude/rules/<名前>.md` に、ルールの行（`- <命令形 1 行>`）を書く。**失敗票 ID は付けない**（失敗票は、あなたの手元にしかない。ID が残っていると、次のコマンドが断る）。対象のファイルを絞れるときは、先頭に `paths:` を付ける（絞らないルールは、起動時に必ず読まれて重い）。Skill は `.claude/skills/<名前>/SKILL.md` に本文を移す（`name` から、リポジトリ名の前置きを外す）。
2. この書き込みには確認が出る（ガードが必ず出す）。**差分を見て承認してもらう。** 流し読みで通さないよう、何が変わるかを 1 行で添える。
3. `harness-note promote --key <原因キー> --to team --path <移した先のファイル> --incident <INC-ID>`。移した先のファイルがあること（空でないこと、失敗票 ID が書かれていないこと）を確かめてから、試用を消す。確かめられなければ、試用は消えない。
4. 1 変換に 1 コミット（例：`harness: ルートの置き場所のルールを追加`）。コミットしてよいか尋ねてから行う。

## 4. そのほかの確認

- **見直しの時期が来た試用（`stale_trials`）**：1 件ずつ「昇格する（自分専用かチームへ）／残す／消す」を尋ねる。昇格は 3 のとおり。確認済みの試用（未確認の一覧にないもの）を消すときは `harness-note trial remove --key <原因キー>`（Skill は `harness-note skill remove --name <名前>`）。
- **バグの候補（`bugs`）**：1 件ずつ「Issue にする／今直す／捨てる」を尋ねる。Issue にしたか直したら `harness-note mark <候補ID> --status consumed`、捨てるなら `--status rejected`。
- **好みの候補（`preferences`）**：本人に確かめ、合っていれば `~/.claude/CLAUDE.md` に 1 行で足す（全リポジトリに効く。確認が出る）。このリポジトリだけの好みなら、リポジトリの `CLAUDE.local.md` か、自分専用のルールに足す。足したら `harness-note mark --key <原因キー> --status consumed`、違うなら `--status rejected`。
- **似た原因キー**：`harness-note keys` を見て、同じ原因に別のキーが付いていれば、`harness-note rekey <今のキー> <まとめ先>` でまとめ直すか尋ねる。

## 5. 終わりに

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs
```

整合と行数の警告があれば伝える（止めない）。残した件数・消した件数・昇格した件数を 1 行でまとめる。`harness-note status` の「自動改善の採否」で消すほうが多いなら、対象にする件数（`candidates.min_sessions`）を上げるか、自動改善を止める（`auto.interval_days` を 0）ことを勧める。どちらも、`~/.claude/self-improve/config.json`（このリポジトリだけなら `~/.claude/self-improve/repos/<名前>/config.json`）で変える。
