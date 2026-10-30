# Android（Kotlin）

> SDK の名前・API・バージョンは変わる。入れる前に、公式ドキュメントとパッケージの最新版を確かめる。

## 定番

| 観点 | 第一候補 | ほか | メモ |
| :- | :- | :- | :- |
| ログ | Timber | Logcat の直書き（`Log.d`）は避ける | リリースでは、warn 以上をエラー監視のパンくずに流す `Tree` だけを植える |
| 障害 | Firebase Crashlytics | Sentry Android、Bugsnag | ANR も見る。Play Console の Android vitals（クラッシュ率・ANR 率）はストアでの扱いに響く |
| 計測 | Firebase Analytics | Amplitude（Kotlin）、PostHog、Mixpanel | |
| 性能 | Android vitals、Firebase Performance | JankStats、Macrobenchmark（起動時間） | |
| リリース | mapping.txt（R8）とネイティブのシンボルのアップロード | — | Crashlytics・Sentry の Gradle プラグインがリリースのビルドで上げる。設定が効いているか CI のログで確かめる |

## 置くもの

- `Application.onCreate` で Timber とエラー監視を初期化（デバッグは `DebugTree`、リリースはパンくずの `Tree`）
- エラー監視の DSN・計測の書き込み用のキーは `local.properties` か CI の環境変数から `BuildConfig` に入れる（リポジトリに書かない）。APK から誰でも取り出せるので、入れてよいのは送信にしか使えない値だけ。mapping のアップロード用のトークンは CI にだけ置く
- 計測のラッパー：`sealed class AnalyticsEvent(val name: String, val params: Map<String, Any?>)` とイベントごとのサブクラス（`object`/`data class`）。呼ぶ側は `analytics.track(AnalyticsEvent.SignupCompleted(method))`
- OkHttp の Interceptor で `traceparent` か `X-Request-ID` を付ける
- ログイン・ログアウトで利用者 ID を付け外しする

## 落とし穴

- R8 の `-assumenosideeffects` で `Log.*` を消すなら、Timber の Tree も含めて動作を確かめる。
- Google Play の「データセーフティ」の申告を、入れた SDK に合わせて更新する。
- 複数のプロセス（`:remote` など）では `Application.onCreate` が何度も呼ばれる。

## チェッカーの設定例

計測の呼び出し（またはラッパーの定義）の見本。下の `event_calls` はこの形に当たる。

```kotlin
data class SignupCompleted(val method: String) : AnalyticsEvent("signup_completed", mapOf("method" to method))
```

```json
{
  "code": {
    "dirs": ["app/src/main"],
    "event_calls": ["AnalyticsEvent\\(\\s*\"([a-z0-9_]+)\""],
    "forbidden": [
      { "pattern": "\\bLog\\.[vdiwe]\\(|\\bprintln\\(", "message": "Timber を使ってください（observability/logging.md）" },
      { "pattern": "\\.logEvent\\(", "message": "計測はラッパー（AnalyticsEvent）を通してください", "allow": ["analytics/AnalyticsClient\\.kt$"] }
    ]
  }
}
```
