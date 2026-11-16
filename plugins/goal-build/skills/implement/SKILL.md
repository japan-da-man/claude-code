---
name: implement
description: 承認済みの docs/specs/<feature>/SPEC.md をテスト先行で実装し、spec-reviewer のレビュー（最大 2 周）を経て goal-build:report まで進める。/goal の中で最初に呼ぶ。止まる必要がある質問は QUESTIONS.md にまとめて blocked で止まる。PR は作らない。
arguments: [feature]
argument-hint: <feature-slug>
---

# goal-build: 実装

`docs/specs/$feature/SPEC.md`（承認済み）を実装し、レビューを経て報告まで進める。多くの場合 /goal の中で動く。/goal の判定役は会話しか読まないので、**チェックやレビューの結果は必ず会話に出す**。

状態はすべてファイルに置く（会話が圧縮されても再開できるように）。

| ファイル | 中身 |
| --- | --- |
| `.goal-build/active` | 1 行目：`docs/specs/$feature`、2 行目：merge-base の SHA、3 行目：承認コミットの SHA |
| `.goal-build/state` | `implementing` / `blocked` / `reported` |
| `.goal-build/stop-count`・`fail-hash`・`last-pass` | Stop フックが使う。再開時に消す |
| `docs/specs/$feature/PROGRESS.md` | AC ごとのタスク（`- [ ]`）、保留、仮定、レビューの周回数 |

フックが次を強制する：承認済み SPEC.md の編集の禁止、`gh pr create` / `gh pr merge` の禁止、ターンを終える前の `.goal-build/check.sh`（失敗していると終われない。同じ失敗が 3 回続くと state が blocked になる）。

## 手順

1. **開始条件**：
   - `docs/specs/$feature/SPEC.md` の frontmatter が `status: approved` でなければ、「SPEC.md が approved でないため開始しなかった」と報告して止まる。
   - `.goal-build/config` を読む（`BASE_BRANCH`、`REVIEW_AGENT`）。なければ `/goal-build:setup` を案内して止まる。
   - `.goal-build/active` があり、1 行目が `docs/specs/$feature` でなければ、別の機能が実行中なので報告して止まる。
   - いまのブランチが `BASE_BRANCH` の名前（例 `main`）と同じなら、`feat/$feature` のような作業ブランチを切る。
2. **再開の判定**：`.goal-build/active` と `PROGRESS.md` が両方あれば再開。手順 3〜5 を飛ばす。
   - state が `blocked`：QUESTIONS.md の blocking に未回答（「回答：」が空）が残っていれば、「blocking な質問が未回答のため blocked のまま」と報告して止まる。すべて回答済みなら、回答をコミットし、state を `implementing` に戻し、`stop-count`・`fail-hash`・`last-pass` を消す。回答で保留が解けた AC を `- [ ]` に戻す。
   - state が `reported`：PROGRESS.md に未完了のタスク（承認ゲート ② で人が足した修正）があれば `implementing` に戻して手順 6 から進める。なければ「報告済み。/goal-build:finish で終えてください」と報告して止まる。
   - レビューの周回数は、再開のたびに 0 に戻す。
3. **初期化**：
   - SPEC.md と QUESTIONS.md をコミットする（承認コミット）。
   - `git merge-base HEAD "$BASE_BRANCH"` を取る（ref がなければ `git fetch origin <branch>` してから）。
   - `.goal-build/active` に 3 行（`docs/specs/$feature`、merge-base の SHA、承認コミットの SHA）を書き、state を `implementing` にする。
4. **タスク分解**：AC ごとに、テストを先に書ける大きさのタスクに分けて PROGRESS.md に書く（`## タスク`、`## 保留`、`## 仮定`、`## レビュー`（周回数）の節）。
5. **事前確認**：SPEC.md・回答済みの QUESTIONS.md・関係するコードを読み、実装で出そうな質問をすべて QUESTIONS.md の「実装」節に書き出す（`${CLAUDE_PLUGIN_ROOT}/references/questions-format.md`）。blocking が 1 件でもあれば、state を `blocked` にして、まとめて 1 回だけ止まる（報告は手順 9 の形）。non-blocking は推奨案で進め、PROGRESS.md の「仮定」に書く。
6. **実装**：タスクごとに次を回す。
   1. 失敗するテストを書き、失敗することを確かめる
   2. 通る最小の実装を書く
   3. `./.goal-build/check.sh` を実行して通す
   4. PROGRESS.md のタスクを `- [x]` にし、コードと一緒にコミットする
   - SPEC.md は編集しない。既存テストの期待値は変えない（変える必要があるなら、それは仕様の変更なので質問にする）。
7. **途中で出た質問**：blocking なら、その AC を PROGRESS.md の「保留」に移し、質問を QUESTIONS.md の「実装」に書いて、**他の AC を先に進める**（すぐには止まらない）。non-blocking は推奨案で進め、「仮定」に書く。
8. **レビュー**（保留中の AC があっても、終わった分を先にレビューする）：
   1. 渡すものを用意する：SPEC.md のパス、`git diff --name-only <merge-base>...HEAD`、既存テストの差分（`git diff <merge-base>...HEAD -- <変更した既存テストのパス>`）、`git diff <承認SHA> -- docs/specs/$feature/SPEC.md`、回答済みの QUESTIONS.md、2 周目なら前回の REVIEW.md。
   2. Agent ツールで `goal-build:spec-reviewer` を呼ぶ。`REVIEW_AGENT` が空でなければ、そのエージェントも並べて呼ぶ（見つからなければ、その旨を REVIEW.md に書いて spec-reviewer だけで続ける）。
   3. 結果を `docs/specs/$feature/REVIEW.md` に周回ごとに追記し、blocking の件数を会話に出す。blocking の判定は spec-reviewer の基準にそろえる。
   4. blocking の指摘だけを直し（直すたびに check.sh）、PROGRESS.md の周回数を 1 増やす。**レビューは最大 2 周**。non-blocking は直さず REPORT に回す。
9. **止まるかの判定**：保留中の AC の質問と、2 周後に残った blocking の指摘があれば、QUESTIONS.md の「実装」にまとめて書き、state を `blocked` にして 1 回だけ止まる。報告は次の形にする。
   - 「blocking な質問を QUESTIONS.md に書き、.goal-build/state を blocked にした」
   - 質問の一覧（番号と 1 行の要約）、終わった AC と保留中の AC
   - 「回答したら同じ /goal を実行し直すと、続きから再開します」
10. **完了**：`./.goal-build/check.sh` を実行して、その出力（末尾）を会話に出す。通ったら Skill ツールで `goal-build:report` を引数 `$feature` で呼ぶ。

## 守ること

- PR を作らない・マージしない（フックでも止まる）。作業ブランチへの push は、頼まれたときだけする。
- `.goal-build/active` を消さない（消すのは人が実行する `/goal-build:finish` だけ）。
- 主張には根拠を付ける。「テストが通った」はコマンドと出力を、「直した」はファイルと行を示す。
