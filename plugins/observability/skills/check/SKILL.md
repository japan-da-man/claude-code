---
name: check
description: 観測の決まりが守られているかを機械で調べ、誤り（ファイル:行と決まり）と、観点の進み具合を一覧にする。トラッキングプランとコードのずれ（プランにないイベントを送っている、active なのに送っていない）、個人情報らしいプロパティ、runbook のないアラート、ロガーを通さないログの直書きなど。直さない。「計測とコードは揃ってる？」「ログの決まりを守れてる？」「/observability:check」と言われたときに使う。
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs check *) Bash(git rev-parse *)
---

# observability:check: 決まりと進み具合を調べる

**このスキルではファイルを変えない。**

対象のリポジトリ（`git rev-parse --show-toplevel`。`observability/config.json` がなければ `/observability:init` を勧めて終える）で、次の 2 つを実行する。

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs check <repo>
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs status <repo>
```

`check` は誤りがあると終了コード 1 になるが、それは失敗ではない。

次の形で見せる。

1. 一行の結論（問題なし／誤り N 件・警告 M 件。イベント・SLO・アラート・runbook・障害の記録・調べたファイルの数）。
2. 誤りと警告があれば表にする（場所、決まり、内容）。同じ決まりで多いもの（直書きのログなど）は、件数と最初の数件にまとめる。決まり（`rule`）:

   | 決まり | 意味 |
   | :- | :- |
   | `config` / `parse` | 設定や YAML が読めない、正規表現が読めない |
   | `events` / `event_name` / `property` | イベントの名前の形・重複、description・owner・status・trigger がない、プロパティの型 |
   | `pii` | 個人情報（に見える名前）のプロパティ |
   | `slo` / `alert` / `runbook` | SLO とアラートの形、runbook がない・節が足りない・どこからも指されない |
   | `incident` | 障害の記録の重要度・状態、resolved なのにポストモーテムがない |
   | `code_event` | プランにないイベントを送っている、active なのに送っていない、planned・deprecated を送っている |
   | `code_forbidden` | 禁止の書き方（ロガーを通さないログ、SDK の直接の呼び出しなど） |

3. 観点の進み具合：`status` の `progress`（決めた観点、残り、次）と、`tools`。
4. `vendored_check` が `stale` なら「`/observability:init` で observability/check.mjs を新しくできます」、`missing` なら「CI 用の check.mjs がありません」と添える。

直すよう頼まれたら、誤りの内容に合わせて直す（プランにないイベントは `/observability:event` でプランに足すか呼び出しを消す、直書きのログはロガーに置き換える、など）。
