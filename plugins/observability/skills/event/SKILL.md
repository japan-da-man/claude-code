---
name: event
description: 計測のイベントを足す・変える・やめる。答えたい問いから、送るタイミングとプロパティを一問一答で決め、トラッキングプラン（observability/events.yaml）と計測のラッパー・呼び出しを直し、チェッカーで確かめる。「〇〇を計測したい」「このボタンが押された数を取りたい」「イベントを追加して」「/observability:event <やりたいこと>」と言われたときに使う。
argument-hint: "<計測したいこと> | <イベント名>"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(node observability/check.mjs*) Bash(git rev-parse *) Bash(git status*) Bash(git diff*)
---

# observability:event: 計測のイベントを足す・変える

やりたいこと: $ARGUMENTS

質問は必ず **AskUserQuestion** で出す（最大 4 問、選択肢つき、おすすめを先頭に「(Recommended)」）。調べれば分かることは聞かない。

## 1. 準備

- 対象のリポジトリは `git rev-parse --show-toplevel`。`observability/config.json` がないか、`progress` に `analytics` がなければ、先に `/observability:init analytics` を案内して終える。
- `observability/README.md` の「計測と分析」、`observability/events.yaml`、計測のラッパー（`config.json` の `code.event_calls` と `forbidden` の `allow` から場所が分かる）を読む。
- 引数がイベント名で、`events.yaml` にあれば「変える・やめる」、なければ「足す」。

## 2. 決める

足すとき：

1. **答えたい問い**：このイベントで何を知りたいか。問いに答えないなら、作らないことを勧める。
2. **もうあるイベントで足りないか**：同じ瞬間を送っているイベントがあれば、プロパティを足すか、そのイベントを使う方を勧める（同じことを別の名前で 2 つ送らない）。
3. **名前**：`config.json` の `events.name_pattern`（既定は `object_action` の過去形 snake_case）で 2〜3 案を出す。
4. **いつ送るか（trigger）**：画面に出たとき / 操作が成功したとき（サーバーの応答の後）/ 押したとき。成功を数えたいなら、押したときではなく成功したときに送る。購入など正確さが要るものは、サーバーから送る方を勧める。
5. **プロパティ**：問いに答えるのに要るものだけ。型（enum の値）、必須か。**個人情報（メール・電話・氏名・住所・自由な入力）は入れない**。名前が個人情報に見えるが違うもの（`email_verified` など）は、`pii_reviewed` に理由を書く。
6. **持ち主（owner）とプラットフォーム**。

変えるとき：プロパティの追加は後方互換なのでそのまま。名前や型・意味を変えるなら、新しいイベントを作り、古いものを `deprecated`（`replaced_by`）にする方を勧める（ダッシュボードの数字が途中で切れるため）。

やめるとき：`status: deprecated` にし、呼び出しを消す。ダッシュボードやファネルで使っていないかを人に確かめてもらう。

決まったら、`events.yaml` に書く内容を見せて AskUserQuestion で確かめる。

## 3. 直す

1. `observability/events.yaml` を書く（`question` に問いを書く）。
2. 計測のラッパーの型・定義に足す（イベント名とプロパティが型になるように）。
3. 送るところに呼び出しを書く（ラッパーを通す）。送り始めたら `status: active`。まだ送らないなら `planned`。
4. feature-docs を使っていて、この機能の `tracking/F-xxx.yaml` があれば、そこにイベントの `name` と `kpi` だけを足す（定義は書き写さない）。
5. 型チェック・テストを動かす。
6. `node observability/check.mjs` が通ることを確かめる。

最後に、変えたもの（イベント、ファイル）と、人がやること（計測の道具の側でファネルやダッシュボードに足す、など）を伝える。
