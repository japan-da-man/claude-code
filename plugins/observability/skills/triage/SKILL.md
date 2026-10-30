---
name: triage
description: 障害の確認と切り分け。症状・アラート・問い合わせから、runbook に沿って影響（いつから・誰に・どれだけ）を確かめ、デプロイの履歴・エラー監視・ログ・メトリクスから原因の候補を絞り、observability/incidents/ に記録する。外に影響する操作（ロールバック・フラグの切り替え・通知）は提案だけで、人の承認なしにはしない。収まったらポストモーテムを書き、足りなかったログやアラートを挙げる。「障害かも」「エラーが増えてる」「アラートが鳴った」「〇〇が動かないと問い合わせが来た」「/observability:triage <症状>」と言われたときに使う。
argument-hint: "<症状 | アラートの id | 記録のファイル>"
model: opus
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs *) Bash(node observability/check.mjs*) Bash(git rev-parse *) Bash(git log *) Bash(git show *) Bash(git diff*) Bash(git tag -l*) Bash(git tag --list*) Bash(gh run list*) Bash(gh run view*) Bash(gh release list*) Bash(gh pr list*) Bash(date *)
---

# observability:triage: 障害を確かめて切り分ける

症状: $ARGUMENTS

**まず影響を止めることが大事で、原因の特定はその後**。分かったことは、すぐ記録に書く（会話にだけ残さない）。

## 守ること

- **実行してよいのは、読むだけの操作に限る**：一覧・取得・検索・ログの表示（`list`・`get`・`describe`・`logs`・`view`・`query`・`search` に当たるもの）。それ以外は、どの MCP・CLI でも実行しない。次も含む：デプロイ・ロールバック・フィーチャーフラグ・本番のデータ、監視の道具の状態（issue の resolve・ignore、アラートの ack・silence・mute、アラートやダッシュボードの設定）、インフラの状態（`kubectl delete` / `rollout restart` / `scale`、キャッシュの削除、再起動）、利用者や社内への通知。読むだけか分からない操作は、実行しない側に倒す。
- これらは人が実行するためのコマンドや手順を渡す。人が「実行して」と言ったときだけ、その操作 1 つを実行し、時刻を記録に書く（1 つの承認を次の操作に広げない）。
- **記録に個人情報と秘密の値を貼らない**。`observability/incidents/` は git の履歴に残り続ける。書くのは件数・割合・時刻・`trace_id` / `request_id`・クエリ・エラーの種類・ファイル:行・コミットまで。ログやエラー監視の行に、メールアドレス・氏名・電話番号・IP アドレス・リクエストの本文・トークン・Cookie があれば、伏せてから（`<email>` のように置き換えて）書く。利用者を指すときは、アプリの内部の ID か「利用者 A」と書く。

## 0. 準備

- 対象のリポジトリは `git rev-parse --show-toplevel`。`observability/README.md` がなければ、決まりがない前提で進め、最後に `/observability:init` を勧める。
- 読む：`observability/README.md`（道具・見る場所・重要度）、`observability/alerts.yaml`、`observability/runbooks/_triage.md`。引数がアラートの id なら、その runbook。
- 引数が `observability/incidents/` のファイルなら、その記録を読んで続きから進める。
- 使える調べ方を確かめる。**接続されている MCP**（Sentry・Datadog・PagerDuty・Grafana など）と、**手元の CLI**（`gh`・`gcloud logging read`・`aws logs`・`kubectl logs`・`vercel logs`・`eas`・`sentry-cli` など）。認証が要るものは、使えないなら人に頼む（認証の情報を聞かない）。

## 1. 影響を確かめる

`_triage.md` の「影響の確かめ方」に沿って：いつから・誰に（OS・バージョン・地域・プラン）・どれだけ（数と割合）・どの流れが失敗しているか。分からないことは「不明」と書く。

README の「重要度」で重要度を決め（迷ったら高い方）、`date` で時刻を取り、`node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs template incident` から `observability/incidents/YYYY-MM-DD-<name>.md` を作る（`status: investigating`）。sev1・sev2 なら、README の運用にある連絡先に知らせるよう人に促す（自分では送らない）。

## 2. 切り分ける

次の順に、証拠（クエリ、件数、時刻、ファイル:行、コミット）を記録の「時系列」と「状況」に書きながら進める（個人情報は伏せる。「守ること」のとおり）。

1. **変更**：始まった時刻の前のデプロイ・リリース・設定。`git log --since` / `gh run list` / `gh release list` / ホスティングのデプロイ履歴 / フィーチャーフラグ。依存しているサービスのステータスページ。
2. **エラー監視**：新しく出た・急に増えたエラー、最初に出たリリース、偏り（OS・バージョン）。
3. **ログ**：失敗した 1 件を `trace_id` / `request_id` で最初から最後まで追う。
4. **メトリクス**：レイテンシ・エラー率・飽和（CPU・メモリ・接続数・キュー）。
5. **コード**：怪しい変更の差分を読み、症状と合うかを確かめる。

仮説は「〇〇だとすると、△△が見えるはず」の形にし、確かめた結果（当たった・外れた）を書く。

## 3. 対処を提案する

影響を止める手段（ロールバック、フラグを切る、段階リリースを止める、スケール）を、効き目と危うさつきで 1〜3 個出し、AskUserQuestion でどれにするかを聞く。

- 「守ること」のとおり、どれも自分では実行しない。人が実行するためのコマンドや手順を渡す。
- 収まったら `status: mitigated` と `mitigated_at`。

## 4. 記録を閉じる

原因が分かり、再発防止まで決まったら、記録のポストモーテムの節（概要・影響・時系列・原因・対処・再発防止）を埋める。責める書き方をしない（人ではなく仕組みの穴を書く）。`status: resolved`・`resolved_at` にし、`node observability/check.mjs` で形を確かめる。

最後に、**観測の穴** を挙げる：気づくのが遅れた（アラートがなかった）、追えなかった（ログに項目がなかった、`trace_id` が途切れた）、読めなかった（シンボルがなかった）。それぞれ、何を足すか（`alerts.yaml`・runbook・`logging.md`・コード）を再発防止の表に入れ、今直すかを AskUserQuestion で聞く。runbook に書けることが増えたら、runbook を更新する。
