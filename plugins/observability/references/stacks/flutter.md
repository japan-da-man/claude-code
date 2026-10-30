# Flutter（Dart）

> SDK の名前・API・バージョンは変わる。入れる前に、pub.dev の最新版と公式ドキュメントを確かめる。

## 定番

| 観点 | 第一候補 | ほか | メモ |
| :- | :- | :- | :- |
| ログ | `package:logging` | `logger` | `Logger.root.onRecord` で、本番はエラー監視のパンくずにだけ流す |
| 障害 | Sentry（`sentry_flutter`） | `firebase_crashlytics` | Dart のエラー（`FlutterError.onError`・`PlatformDispatcher.instance.onError`）とネイティブのクラッシュの両方を取る |
| 計測 | `firebase_analytics` | `posthog_flutter`、`amplitude_flutter`、`mixpanel_flutter` | 画面は `NavigatorObserver`（go_router なら observers）で 1 か所から |
| リリース | `--obfuscate --split-debug-info` のシンボルと dSYM・mapping のアップロード | | Sentry は `sentry_dart_plugin`、Crashlytics は Firebase CLI の symbols のアップロード |

## 置くもの

- `main.dart` で `SentryFlutter.init(…, appRunner: () => runApp(…))`（または Crashlytics の初期化と 2 つのエラーハンドラ）
- DSN は `--dart-define`（CI の環境変数から）。リポジトリに書かない。アプリから取り出せるので、入れてよいのは DSN のような送信にしか使えない値だけ。シンボルのアップロード用のトークンは CI にだけ置く
- 計測のラッパー：`class AnalyticsEvent { const AnalyticsEvent(this.name, [this.params = const {}]); }` とイベントごとのファクトリ（`static AnalyticsEvent signupCompleted(SignupMethod m) => AnalyticsEvent('signup_completed', {'method': m.name});`）
- http クライアント（dio の Interceptor など）で `traceparent` か `X-Request-ID` を付ける

## 落とし穴

- 難読化したら、シンボルを上げないとスタックトレースが読めない。
- `kDebugMode` のときは送らない。

## チェッカーの設定例

計測の呼び出し（またはラッパーの定義）の見本。下の `event_calls` はこの形に当たる。

```dart
static AnalyticsEvent signupCompleted(SignupMethod m) => AnalyticsEvent('signup_completed', {'method': m.name});
```

```json
{
  "code": {
    "dirs": ["lib"],
    "event_calls": ["AnalyticsEvent\\(\\s*'([a-z0-9_]+)'"],
    "forbidden": [
      { "pattern": "\\b(print|debugPrint)\\(", "message": "Logger を使ってください（observability/logging.md）" },
      { "pattern": "FirebaseAnalytics\\.instance\\.logEvent\\(", "message": "計測は AnalyticsEvent を通してください", "allow": ["lib/analytics/analytics_client\\.dart$"] }
    ]
  }
}
```
