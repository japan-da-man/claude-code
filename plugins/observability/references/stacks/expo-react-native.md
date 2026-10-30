# Expo / React Native

> SDK の名前・API・バージョンは変わる。Expo の SDK のバージョンに合うものを入れる（`npx expo install`）。入れる前に公式ドキュメントを確かめる。

## 定番

| 観点 | 第一候補 | ほか | メモ |
| :- | :- | :- | :- |
| ログ | 薄いロガー（`src/lib/logger.ts`） | react-native-logs | 開発は console、本番はエラー監視のパンくずにだけ残す |
| 障害 | Sentry（`@sentry/react-native`、Expo の config plugin） | `@react-native-firebase/crashlytics`、Bugsnag | ネイティブの SDK は Expo Go では動かない。開発ビルド（`expo-dev-client`）が要る |
| 計測 | PostHog（`posthog-react-native`） | Amplitude（`@amplitude/analytics-react-native`）、`@react-native-firebase/analytics` | 画面は Expo Router の `usePathname` の変化で 1 か所から送る |
| 性能 | Sentry のパフォーマンス（起動・画面の表示） | | |
| リリース | ソースマップのアップロード | | EAS Build では Sentry のプラグインが上げる。**EAS Update（OTA）は別に上げる**（Sentry の Expo 向けの手順を確かめる） |

## 置くもの

- `app.json` の `plugins` に Sentry の config plugin、`metro.config.js` を Sentry の Expo 向けの設定に（ソースマップのため）
- ルートの `_layout.tsx` でエラー監視を初期化し、ルートを `Sentry.wrap` かエラーバウンダリで包む。`release`・`dist` と、EAS Update の `Updates.updateId` をタグに付ける
- DSN は `EXPO_PUBLIC_SENTRY_DSN`（`EXPO_PUBLIC_` の値はアプリに埋め込まれ誰でも読める。DSN は送信にしか使えないのでよい）。ソースマップのアップロード用の `SENTRY_AUTH_TOKEN` は、EAS の環境変数（visibility を secret）と CI の secret にだけ置く
- 計測のラッパー `src/lib/analytics.ts`：イベント名とプロパティの型を 1 つの型にまとめる

  ```ts
  type Events = {
    signup_completed: { method: 'email' | 'apple' | 'google' }
    item_added_to_cart: { item_id: string; price: number }
  }
  export function track<K extends keyof Events>(name: K, props: Events[K]) { … }
  ```

- `fetch` のラッパーで `traceparent` か `X-Request-ID` を付ける
- ATT が要るなら `expo-tracking-transparency`。プライバシーマニフェストは `app.json` の `ios.privacyManifests`

## 落とし穴

- Hermes のソースマップがないと、スタックトレースが読めない。
- `__DEV__` のときは送らない（`enabled: !__DEV__`）。開発中のエラーで本番のアラートが鳴る。
- Web にも出すなら、計測の SDK が Web で動くか（または `.web.ts` で分ける）を確かめる。

## チェッカーの設定例

計測の呼び出し（またはラッパーの定義）の見本。下の `event_calls` はこの形に当たる。

```ts
track('signup_completed', { method: 'apple' })
```

```json
{
  "code": {
    "dirs": ["src", "app"],
    "exclude": ["\\.test\\.[jt]sx?$"],
    "event_calls": ["\\btrack\\(\\s*['\"]([a-z0-9_]+)['\"]"],
    "forbidden": [
      { "pattern": "console\\.(log|info|debug)\\(", "message": "logger を使ってください（observability/logging.md）", "allow": ["src/lib/logger\\.ts$"] },
      { "pattern": "from ['\"](posthog-react-native|@amplitude/analytics-react-native|@react-native-firebase/analytics)['\"]", "message": "計測は src/lib/analytics.ts を通してください", "allow": ["src/lib/analytics\\.ts$", "app/_layout\\.tsx$"] }
    ]
  }
}
```
