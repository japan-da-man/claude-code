# JVM（Spring Boot・Ktor・Micronaut）

> ライブラリの名前・API・バージョンは変わる。入れる前に、公式ドキュメントと最新版を確かめる。

## 定番

| 観点 | 第一候補 | ほか | メモ |
| :- | :- | :- | :- |
| ログ | SLF4J ＋ Logback。Spring Boot 3.4 以降は標準の構造化ログ（`logging.structured.format.console`） | logstash-logback-encoder（それより前の版） | |
| リクエストの文脈 | MDC（Micrometer Tracing が `traceId`・`spanId` を入れる） | | |
| 障害 | Sentry（Spring Boot の starter） | Datadog、New Relic | |
| メトリクス | Micrometer ＋ Actuator（`/actuator/prometheus`） | | |
| トレース | Micrometer Tracing（OpenTelemetry のブリッジ）か OpenTelemetry の Java エージェント（コードを変えない） | Datadog のエージェント | |

## 置くもの

- `application.yml`：構造化ログの形、`management.endpoints` と `management.tracing.sampling.probability`
- フィルタで `X-Request-ID` を MDC に入れる（トレースがあれば `traceId` を使う）
- `@ControllerAdvice`：想定したエラーは warn、想定外は error とエラー監視へ
- Ktor は `CallLogging`・`CallId` のプラグインで同じことをする

## 落とし穴

- `System.out.println` と `e.printStackTrace()` は構造化されず、MDC も付かない。
- Actuator の公開範囲（`/actuator/env` などを外に出さない）。

## チェッカーの設定例

計測の呼び出し（またはラッパーの定義）の見本。下の `event_calls` はこの形に当たる。

```kotlin
analytics.track("signup_completed", mapOf("method" to "email"))
```

```json
{
  "code": {
    "dirs": ["src/main"],
    "extensions": [".java", ".kt"],
    "event_calls": ["analytics\\.track\\(\\s*\"([a-z0-9_]+)\""],
    "forbidden": [
      { "pattern": "System\\.(out|err)\\.print|\\.printStackTrace\\(", "message": "ロガーを使ってください（observability/logging.md）" }
    ]
  }
}
```
