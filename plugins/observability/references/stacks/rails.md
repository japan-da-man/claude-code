# Ruby on Rails

> gem の名前・API・バージョンは変わる。入れる前に、公式ドキュメントと gem の最新版を確かめる。

## 定番

| 観点 | 第一候補 | ほか | メモ |
| :- | :- | :- | :- |
| ログ | lograge（1 リクエスト 1 行、JSON） | rails_semantic_logger | `config.log_tags = [:request_id]` |
| 伏せる値 | `config.filter_parameters`（`filter_parameter_logging.rb`） | | ログとエラー監視の両方に効く。足りないキーを足す |
| 障害 | Sentry（`sentry-ruby`・`sentry-rails`） | Datadog、Honeybadger | Rails のエラーレポーター（`Rails.error.report`）からも届くようにする |
| メトリクス・トレース | OpenTelemetry（`opentelemetry-instrumentation-all`） | Datadog（`datadog` gem）、yabeda＋Prometheus | |
| 計測 | 計測の道具のサーバー用 SDK | Ahoy（自前でデータを持つ） | |

## 置くもの

- `config/initializers/lograge.rb`：JSON の形、`custom_options` で `request_id`・利用者 ID・`trace_id`
- `config/initializers/sentry.rb`：DSN は credentials か環境変数、`release`・`environment`、`send_default_pii = false`
- 計測のラッパー `app/lib/analytics.rb`：`Analytics.track(:signup_completed, user:, method:)`。ジョブ（Active Job）から送ると、リクエストを遅くしない

## 落とし穴

- 既定のログは複数行で、集約で読みにくい。
- `Rails.logger.info("… #{user.email}")` のように値を文に埋め込まない。

## チェッカーの設定例

計測の呼び出し（またはラッパーの定義）の見本。下の `event_calls` はこの形に当たる。

```ruby
Analytics.track(:signup_completed, user:, method: "email")
```

```json
{
  "code": {
    "dirs": ["app", "lib"],
    "extensions": [".rb"],
    "event_calls": ["Analytics\\.track\\(\\s*[:'\"]([a-z0-9_]+)"],
    "forbidden": [
      { "pattern": "^[ \\t]*(puts|pp|p)\\s", "message": "Rails.logger を使ってください（observability/logging.md）" },
      { "pattern": "logger\\.\\w+\\(?\\s*\"[^\"]*#\\{", "message": "値は文に埋め込まず、項目で渡してください", "level": "warning" }
    ]
  }
}
```
