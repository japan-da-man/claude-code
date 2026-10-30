# Node.js（Express・Fastify・NestJS・Hono など）

> SDK の名前・API・バージョンは変わる。入れる前に、公式ドキュメントとパッケージの最新版を確かめる。

## 定番

| 観点 | 第一候補 | ほか | メモ |
| :- | :- | :- | :- |
| ログ | pino（Fastify は標準。Express は `pino-http`、NestJS は `nestjs-pino`） | winston | JSON を標準出力に出し、集めるのはホスティングかエージェントに任せる |
| リクエストの文脈 | `AsyncLocalStorage` に `request_id`・`trace_id`・利用者 ID | | ロガーがここから項目を付ける |
| 障害 | Sentry（`@sentry/node`。ほかの import より先に初期化する） | Datadog APM、Bugsnag | `unhandledRejection` を見逃さない |
| メトリクス・トレース | OpenTelemetry（`@opentelemetry/sdk-node` と auto-instrumentations、OTLP で送る） | `prom-client` の `/metrics`、Datadog（dd-trace） | |
| 計測（サーバー側） | 計測の道具のサーバー用 SDK（posthog-node・Amplitude など） | | 購入・課金など、正確さが要るイベントはサーバーから |

## 置くもの

- `src/lib/logger.ts`：pino、`redact`（`req.headers.authorization`・`req.headers.cookie`・`*.password`・`*.token`）、`base` に `service`・`version`・`env`
- リクエストのミドルウェア：`X-Request-ID` か `traceparent` を受け取る（なければ作る）、レスポンスに返す、`AsyncLocalStorage` に入れる、終わりに 1 行（route・status・duration_ms）
- 初期化のファイル（`instrument.ts`）を `node --import` で先に読み込む（Sentry・OpenTelemetry）
- エラーハンドラ：想定したエラー（4xx）は warn、想定外（5xx）は error とエラー監視へ
- `/healthz`（生きているか）と、必要なら `/readyz`（依存先につながるか）

## 落とし穴

- `console.log(obj)` は複数行になり、ログの集約で 1 件として読めない。
- ログのレベルを環境変数（`LOG_LEVEL`）で変えられるようにする。
- auto-instrumentations はすべて有効だと量が多い。使うものだけにする。

## チェッカーの設定例

計測の呼び出し（またはラッパーの定義）の見本。下の `event_calls` はこの形に当たる。

```ts
track('order_completed', { order_id: order.id })
```

```json
{
  "code": {
    "dirs": ["src"],
    "exclude": ["\\.(test|spec)\\.ts$"],
    "event_calls": ["\\btrack\\(\\s*['\"]([a-z0-9_]+)['\"]"],
    "forbidden": [
      { "pattern": "console\\.(log|info|debug|error|warn)\\(", "message": "logger を使ってください（observability/logging.md）", "allow": ["src/lib/logger\\.ts$", "scripts/"] },
      { "pattern": "logger\\.\\w+\\([^)]*\\b(password|token|authorization)\\b", "message": "秘密の値をログに出していないか確かめてください", "level": "warning" }
    ]
  }
}
```
