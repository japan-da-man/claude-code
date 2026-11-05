# review/

[layered-review](https://github.com/japan-da-man/claude-code/tree/main/plugins/layered-review) の置き場所。コードレビューを 1 つの関門ではなく、いくつもの層で受け止める。

| 層 | 何をするか | どこで |
| :- | :- | :- |
| 1. PR の前の検証 | テスト・型・lint を回し、結果を見せる。別のコンテキストのエージェントが差分を見る | `/layered-review:review` |
| 2. AI のレビュー | 観点別のエージェントが探し、別のエージェントの投票で誤検知を落とす | `/layered-review:review` |
| 3. 自動のチェック | CI。指摘のスレッドはすべて解決してからマージ | GitHub のブランチ保護 |
| 4. 人の承認 | 変更の中身でリスク段階を決め、段階に応じて人を入れる | `config.json` の `risk` / `approvals`、CODEOWNERS |
| 5. 戻す | 1 回で戻せること（revert・feature flag・EAS Update など） | PR テンプレートの「戻し方」 |
| 6. 直す | 見逃したバグを eval のケースにして、レビューを測る | `/layered-review:eval` |

## ファイル

- `config.json`：回すチェック、リスク段階のパス、レビューの深さ、往復の上限、人の承認、eval の重み
- `check.mjs`：プラグインなしで動くチェッカー（CI で使う）。`node review/check.mjs` で形を調べ、`node review/check.mjs risk --base origin/main --head HEAD` でリスク段階を出す
- `evals/cases/C-xxx-*.json`：見逃したバグ（と、問題のない変更）の正解。人が場所と内容を確かめたものだけ
- `evals/runs/<日時>-<ラベル>/`：レビューの仕組みを変えたときの実行結果。`node review/check.mjs score <dir>` で採点、`compare <古い> <新しい>` で比べる
- `outcomes.jsonl`：指摘への対応結果（直した・却下・意図どおり・問題にしなかった）。`node review/check.mjs outcomes` で集計

## 決まり

- リスク段階は **作者ではなく変更で決める**。
- エージェントの承認は人の承認に数えない。エージェントが書いた PR は、動かした人が作者として責任を持つ。
- 1 つの PR でレビューを回すのは `review.max_rounds` 回まで。2 回目からは前回からの差分だけを見る。
- レビューの指示（REVIEW.md・プロンプト・モデル）を変えたら、eval を回して前回と比べる。
