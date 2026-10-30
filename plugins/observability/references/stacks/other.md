# ほかのスタック

`references/stacks/` にないスタック（Rust・Elixir・PHP・.NET・Unity など）や、判定できなかったとき。

## 選び方

1. **ログ**：その言語の標準か最も使われているロガーで、JSON（サーバー）か、プラットフォームの標準のログ（クライアント）に出す。項目は `observability/logging.md` に揃える。
2. **障害**：Sentry はほとんどの言語・エンジンに SDK がある。会社で契約している APM があればそれを優先。
3. **メトリクス・トレース**：OpenTelemetry に SDK があるか確かめる（ベンダーを選ばずに済む）。なければ Prometheus の形のメトリクス。
4. **計測**：クライアントなら計測の道具の SDK、なければサーバー側から HTTP API で送る。

入れる前に、公式ドキュメントとパッケージの最新版を確かめる（WebSearch）。見つけた定番は、そのリポジトリの `observability/README.md` に理由と一緒に書く。

## チェッカーの設定

`code.extensions` にその言語の拡張子を、`code.event_calls` に計測のラッパーの呼び出しの正規表現（1 つ目のグループがイベント名）を、`code.forbidden` に標準出力への直書きを書く。正規表現は JavaScript の書き方で、フラグは `g` と `m`（`^` と `$` は行の先頭と終わり）。
