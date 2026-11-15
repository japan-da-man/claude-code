---
name: review
description: 自動改善が入れた未確認の変更（試用ルール、試用 Skill、承認待ちの案、対策を入れなかった記録）を 1 件ずつ見せ、「残す／直す／消す／昇格する」を人に選んでもらって反映する。あわせて、見直しの時期が来た試用、バグの候補、重なった好みの候補も確認する。セッション開始時に「自動改善（…）」「未確認の自動変更 N 件」と出たとき、「自動変更を確認して」「試用ルールを見せて」「改善候補を見せて」「/self-improve:review」と言われたときに使う。
allowed-tools: Bash(harness-note *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/test-guards.mjs *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs *) Bash(git rev-parse *) Bash(git status*) Bash(git diff*) Bash(git log*)
---

# self-improve:review: 自動変更を 1 件ずつ確認する

自動改善は、人が証拠を見る前に試用を効かせている。ここで人が中身を見て、定着させるかどうかを決める。**決めるのは人。** 選択は **AskUserQuestion** で 1 件ずつ尋ね、まとめて承認させない。

`harness/config.json` がなければ、`/self-improve:init` を勧めて終える。

`harness-note` が「--session を付けて呼んでください」と返したら（自動改善が別のセッションで実行中のとき）、`--session ${CLAUDE_SESSION_ID}` を付けて呼び直す。

## 1. 一覧を取る

```bash
harness-note review
```

JSON が返る。

| 項目 | 中身 |
| :- | :- |
| `unreviewed` | 未確認の自動変更。`kind` は `trial_add`（試用ルールの追加）・`trial_edit`（再発による編集）・`skill_add`（試用 Skill）・`proposal`（承認待ちの案）・`draft`（対策を入れなかった記録）。`rule`・`skill` に中身、`draft` に失敗票の下書き |
| `stale_trials` | 置いてから見直しの日数（初期値 60 日）を超えた試用 |
| `bugs` | バグの候補（`dev/bug`） |
| `preferences` | 3 セッション以上で重なった好みの候補 |
| `other_drafts` | 未確認の変更に結び付いていない下書き |
| `next_incident_id` | 次に振る失敗票の番号 |

何もなければ「確認するものはありません」と伝えて終える。経緯を読みたいときは `harness-note report show`（直近の実行の記録）、`harness-note episodes <原因キー>`（事象メモ）。

## 2. 未確認の自動変更を 1 件ずつ

1 件ごとに、次を見せてから尋ねる。

- 何が入ったか（試用ルールの 1 行、Skill の全文、案の中身）。`trial_edit` なら、直す前の文言（`rule.previous`）も
- 根拠（下書きの「実際の結果」と「根拠」）。事象メモがあれば、内容が合っているかを確かめてもらう
- 置いてからの日数、同じ原因がまた出ているか

### 試用ルール・試用 Skill（`trial_add` / `trial_edit` / `skill_add`）

| 選ぶもの | すること |
| :- | :- |
| 残す | 下書き（`draft`）をもとに `harness/incidents/<next_incident_id>.md` を書く（`id` を番号に、`status: trial`）。`harness-note review done <変更ID> --decision keep --incident <INC-ID>`。失敗票をコミットする |
| 直す | 文言を尋ね、`harness-note trial edit --key <原因キー> --text "<直した 1 行>"`。あとは「残す」と同じで、`--decision edit` で記録する。Skill を直したいときは、昇格して `.claude/skills/` で直す |
| 消す | `harness-note review done <変更ID> --decision remove`。試用を消し、下書きを捨て、その原因を「断られた」と記録する（新しい候補が 2 件たまるまで、自動改善の対象から外れる）。同じ内容が Claude Code の自動メモリに残っていることがあるので、`/memory` も確かめるよう伝える |
| 昇格する | 下の「昇格」のとおりに `.claude/rules/`（Skill は `.claude/skills/`）へ移してから、`harness-note review done <変更ID> --decision promote --path <移した先>` |

何も選ばなければ、試用のまま効き続ける（未確認が上限に達すると、自動改善は新しい追加をやめる）。

### 承認待ちの案（`proposal`、または `proposal: true` の付いた試用）

下書きの「承認待ちの案」を見せる。ガード、検証コマンド、git 管理下のファイルの編集のどれか。

- **承認**：案を反映する。ガードは `harness/guards.json` に足し、`harness/guards.test.json` に「止めるべき入力」と「止めてはいけない入力」を 1 件ずつ足して、`node ${CLAUDE_PLUGIN_ROOT}/scripts/test-guards.mjs <repo>` を通す。検証コマンドは `harness/config.json` の `verify` に足し、問題のある状態で `node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs <repo>` が失敗することを見る。失敗票を `harness/incidents/` に書き（`status: converted`、`control` に足した制御のパス）、`harness-note review done <変更ID> --decision apply --incident <INC-ID>`。
- **却下**：`harness-note review done <変更ID> --decision dismiss`（下書きを捨て、その原因を「断られた」と記録する）。

### 対策を入れなかった記録（`draft`）

自動改善が「環境が原因」「再現しない」などと判断して、記録だけ残したもの。

- **記録として残す**：失敗票を `harness/incidents/` に書き（`status: wontfix`）、`--decision keep --incident <INC-ID>`。
- **捨てる**：`--decision dismiss`。
- 判断が違う（対策を入れたい）ときは、`--decision keep` で記録を残してから `/self-improve:retro <原因キー>` を勧める。

## 3. 昇格

昇格は日数で自動判定しない。判断の材料は、置いてからの日数と、同じ原因がまた出たかどうか。

1. `.claude/rules/<名前>.md` に、ルールの行（`- <命令形 1 行>（INC-YYYY-NNNN）`）を書く。対象のファイルを絞れるときは、先頭に `paths:` を付ける（絞らないルールは、起動時に必ず読まれて重い）。Skill は `.claude/skills/<名前>/SKILL.md` に本文を移す。
2. この書き込みには確認が出る（ガードが必ず出す）。**差分を見て承認してもらう。** 流し読みで通さないよう、何が変わるかを 1 行で添える。
3. 失敗票を `harness/incidents/` に書く（`status: converted`、`control` に移した先、`promoted_at` に今日）。
4. `harness-note review done <変更ID> --decision promote --path <移した先>`（試用を消す）。
5. 1 変換に 1 コミット：`harness(INC-YYYY-NNNN): <何を足したか>`。

## 4. そのほかの確認

- **見直しの時期が来た試用（`stale_trials`）**：1 件ずつ「昇格する／残す／消す」を尋ねる。人が入れた試用（未確認の一覧にないもの）を消すときは `harness-note trial remove --key <原因キー>`（Skill は `harness-note skill remove --name <名前>`）。昇格で消すときは `--keep-cause` を付ける。
- **バグの候補（`bugs`）**：1 件ずつ「Issue にする／今直す／捨てる」を尋ねる。Issue にしたか直したら `harness-note mark <候補ID> --status consumed`、捨てるなら `--status rejected`。
- **好みの候補（`preferences`）**：本人に確かめ、合っていれば CLAUDE.md に 1 行で足す（確認が出る）。足したら `harness-note mark --key <原因キー> --status consumed`、違うなら `--status rejected`。
- **似た原因キー**：`harness-note keys` を見て、同じ原因に別のキーが付いていれば、`harness-note rekey <今のキー> <まとめ先>` でまとめ直すか尋ねる。

## 5. 終わりに

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs <repo>
```

整合と行数の警告があれば伝える（止めない）。残した件数・消した件数・昇格した件数を 1 行でまとめる。`harness-note status` の「自動改善の採否」で消すほうが多いなら、対象にする件数（`candidates.min_sessions`）を上げるか、自動改善を止める（`auto.interval_days` を 0）ことを勧める。
