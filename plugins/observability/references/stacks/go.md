# Go

> SDK の名前・API・バージョンは変わる。入れる前に、公式ドキュメントとモジュールの最新版を確かめる。

## 定番

| 観点 | 第一候補 | ほか | メモ |
| :- | :- | :- | :- |
| ログ | `log/slog`（標準。`slog.NewJSONHandler`） | zap、zerolog | 新しく作るなら標準の slog |
| リクエストの文脈 | `context.Context` に `request_id`、`slog` の Handler で付ける | | |
| 障害 | Sentry（`sentry-go`、`sentryhttp` などのミドルウェア） | Datadog（dd-trace-go） | panic を recover して報告する |
| メトリクス・トレース | OpenTelemetry（`otelhttp`・`otelgrpc`、OTLP で送る） | Prometheus（`client_golang` の `promhttp`） | |

## 置くもの

- `internal/obs/log.go`：JSON の Handler、`ReplaceAttr` で伏せるキーを消す、`service`・`version`・`env` を付ける
- HTTP のミドルウェア：`X-Request-ID` か `traceparent`、context に入れる、終わりに 1 行（route・status・duration_ms）
- `main` で OpenTelemetry の TracerProvider と MeterProvider を作り、終了時に `Shutdown`（送り切る）

## 落とし穴

- `fmt.Println` と標準の `log.Printf` は構造化されない。
- ゴルーチンに context を渡し忘れると、ログとトレースがつながらない。

## チェッカーの設定例

計測の呼び出し（またはラッパーの定義）の見本。下の `event_calls` はこの形に当たる。

```go
analytics.Track(ctx, "signup_completed", map[string]any{"method": "email"})
```

```json
{
  "code": {
    "dirs": ["."],
    "extensions": [".go"],
    "exclude": ["_test\\.go$"],
    "event_calls": ["\\.Track\\(\\s*\\w+\\s*,\\s*\"([a-z0-9_]+)\""],
    "forbidden": [
      { "pattern": "\\bfmt\\.Print(ln|f)?\\(|\\blog\\.Print(ln|f)?\\(", "message": "slog を使ってください（observability/logging.md）", "allow": ["^cmd/.*/main\\.go$"] }
    ]
  }
}
```
