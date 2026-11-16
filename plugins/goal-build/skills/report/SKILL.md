---
name: report
description: goal-build:implement が終わったときに、REPORT.md と PR 本文の下書き PR_BODY.md を書き、state を reported にして PR の前で止まる。implement から呼ばれる。PR は作らない。
arguments: [feature]
argument-hint: <feature-slug>
---

# goal-build: 報告

実装の結果を、人が承認ゲート ② で読む報告書にまとめ、PR の前で止まる。以下の `$feature` が置き換わらずにそのまま残っていたら、Skill ツールに渡された引数の値（機能のスラッグ）を使う。

## 手順

1. `.goal-build/active` から merge-base の SHA（2 行目）と承認コミットの SHA（3 行目）を読む。
2. `${CLAUDE_PLUGIN_ROOT}/references/report-template.md` に従い、`docs/specs/$feature/REPORT.md` を書く。材料は SPEC.md・PROGRESS.md・REVIEW.md・QUESTIONS.md と次のコマンドの結果。
   - `git diff --stat <merge-base>...HEAD`
   - 変更された既存テスト：`git diff --name-only --diff-filter=M <merge-base>...HEAD` のうちテストのファイル。あれば差分の要点を書く
   - SPEC.md の差分：`git diff <承認SHA> -- docs/specs/$feature/SPEC.md`。なければ「なし」と書く（あれば目立つように書く）
   - `./.goal-build/check.sh` の最後の出力の末尾
3. PR 本文の下書きを `docs/specs/$feature/PR_BODY.md` に書く：概要、AC ごとの対応、テスト、レビューで残った点、確認してほしいこと。人がそのまま貼れる形にする。
4. REVIEW.md・REPORT.md・PR_BODY.md をコミットする。
5. `.goal-build/state` を `reported` にする。`.goal-build/active` は消さない（最後のターンも Stop フックでチェックするため）。
6. 次の形で報告して終える。
   - 「goal-build:report で REPORT.md と PR_BODY.md を作成した。PR の作成の前で止めている」
   - REPORT.md のパスと、要約（3〜5 行）、人に見てほしい点
   - 次の手順：REPORT.md と差分を確認する → 直したい点があれば PROGRESS.md にタスクとして足して同じ /goal を実行し直す → 問題がなければ `/goal-build:finish` を実行してから PR を作る

## 守ること

- PR を作らない・push しない（頼まれていない限り）。
- 報告に書く数字や結果は、実行したコマンドの出力から写す。推測で書かない。
