---
name: finish
description: goal-build のフローを終える（承認ゲート ② のあと、または途中でやめるとき）。.goal-build/ の状態ファイルを消してフックを止め、PR を作るコマンドを示す。PR は人が作る。
disable-model-invocation: true
---

# goal-build: 終了

実行中のフローを終え、goal-build のフックを止める。PR の作成はしない（コマンドを示すだけ）。

## 手順

1. **/goal が動いていないか**：このセッションで /goal が有効なら（`◎ /goal active` が出ている、または判定が続いている）、先に `/goal clear` を実行するよう伝えて止まる。ゴールが残ったまま状態を消すと、フックが外れた状態で作業が続いてしまう。分からなければ、実行したかを AskUserQuestion で確かめる。
2. **状態を読む**：`.goal-build/active`（1 行目の仕様ディレクトリ）と `.goal-build/state` を読む。active がなければ「実行中のフローはない」と伝えて終える。
3. **PR の案内**：state が `reported` なら、REPORT.md のパスと、PR を作るコマンドの例を示す（実行はしない）。

   ```text
   git push -u origin <いまのブランチ>
   gh pr create --body-file docs/specs/<feature>/PR_BODY.md
   ```

   `reported` でなければ、途中で終えることになる旨と、終わった AC・保留中の AC・未回答の質問を短く伝える。
4. **状態を消す**：`.goal-build/` の `active`・`state`・`stop-count`・`fail-hash`・`last-pass` を消す。`check.sh` と `config` は残す。`docs/specs/` の成果物は消さない。
5. 消したことと、次に別の機能を始めるときは `/goal-build:design` からであることを伝える。
