# Web（Next.js / React・Vue などの SPA）

> SDK の名前・API・バージョンは変わる。入れる前に、公式ドキュメントとパッケージの最新版を確かめる。

## 定番

| 観点 | 第一候補 | ほか | メモ |
| :- | :- | :- | :- |
| ログ（サーバー側） | pino（JSON を標準出力） | ホスティングの標準（Vercel の Log Drains など） | Next.js の Route Handler・Server Action・ミドルウェアのログ |
| ログ（ブラウザ） | 送らない。エラー監視のパンくずに残す | Datadog Browser Logs | |
| 障害 | Sentry（`@sentry/nextjs`。ウィザードで `instrumentation.ts`・`global-error.tsx` を作る） | Datadog RUM、Bugsnag | ソースマップはビルドで上げて、公開しない |
| 計測 | PostHog（`posthog-js`） | Amplitude（Browser SDK）、GA4（集客の分析） | Cookie の同意の後に始める |
| 性能 | Web Vitals（LCP・INP・CLS）。Next.js は `useReportWebVitals` | `web-vitals`、Sentry・Datadog の RUM | |
| トレース | OpenTelemetry（Next.js は `@vercel/otel` を `instrumentation.ts` で） | APM の SDK | |

## 置くもの

- サーバーのロガー `src/lib/logger.ts`（pino、`redact` で authorization・cookie・password などを伏せる）。ブラウザ用は console を包んで本番で黙らせる
- エラー監視の初期化（クライアント・サーバー・edge）と、`error.tsx` / `global-error.tsx` からの報告
- 計測のラッパー `src/lib/analytics.ts`（Expo と同じく、イベント名とプロパティを 1 つの型に）。同意の状態で送るかを決める
- `fetch` のラッパーかミドルウェアで `traceparent` か `X-Request-ID` を受け渡す
- `NEXT_PUBLIC_` の付く環境変数はブラウザに出る。認証トークン（ソースマップのアップロード用など）には付けない

## 落とし穴

- Session Replay は入力をマスクする設定を確かめる（既定の挙動は SDK ごとに違う）。
- 広告ブロッカーで計測が落ちる。正確さが要るイベント（購入など）はサーバー側から送る。
- 同じイベントをクライアントとサーバーの両方から送らない。

## チェッカーの設定例

計測の呼び出し（またはラッパーの定義）の見本。下の `event_calls` はこの形に当たる。

```ts
track('signup_completed', { method: 'email' })
```

```json
{
  "code": {
    "dirs": ["src", "app"],
    "exclude": ["\\.(test|spec)\\.[jt]sx?$"],
    "event_calls": ["\\btrack\\(\\s*['\"]([a-z0-9_]+)['\"]"],
    "forbidden": [
      { "pattern": "console\\.(log|info|debug)\\(", "message": "logger を使ってください（observability/logging.md）", "allow": ["src/lib/logger\\.ts$"] },
      { "pattern": "posthog\\.capture\\(|gtag\\(\\s*['\"]event", "message": "計測は src/lib/analytics.ts を通してください", "allow": ["src/lib/analytics\\.ts$"] }
    ]
  }
}
```
