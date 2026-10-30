# iOS（Swift / SwiftUI）

> SDK の名前・API・バージョンは変わる。入れる前に、公式ドキュメントとパッケージの最新版を確かめる。

## 定番

| 観点 | 第一候補 | ほか | メモ |
| :- | :- | :- | :- |
| ログ | `os.Logger`（OSLog） | swift-log（サーバーの Swift と揃えるとき） | subsystem はバンドル ID、category は機能。本番のログはサーバーに送らず、エラー監視のパンくずに残す |
| 障害 | Sentry（sentry-cocoa、SPM） | Firebase Crashlytics、Bugsnag | クラッシュのハンドラは 1 つに絞る（2 つ入れると片方が取りこぼす） |
| ハング・電池・起動 | MetricKit（`MXMetricManager`） | Sentry のパフォーマンス、Xcode Organizer | MetricKit は無料。前日の集計とクラッシュ・ハングの診断が届く |
| 計測 | Firebase Analytics | Amplitude（Amplitude-Swift）、PostHog（posthog-ios）、TelemetryDeck、Mixpanel | 他社のアプリやサイトのデータと結びつけてトラッキングする（広告の効果測定の SDK に渡す、データブローカーに渡す）なら ATT が要る。IDFA を使わなくても同じ |
| リリース | dSYM のアップロード | — | `DEBUG_INFORMATION_FORMAT = dwarf-with-dsym`（Release）。Xcode Cloud なら `ci_scripts/ci_post_xcodebuild.sh`、fastlane なら upload の action |

## 置くもの

- `Logger` の拡張（`Logger.network`・`Logger.auth` のように category ごと）。値は既定で private になる。出してよい値だけ `privacy: .public` にする
- `App` の `init` でエラー監視を初期化（DSN は Info.plist のビルド設定か xcconfig から。リポジトリに書かない。アプリから取り出せるので、入れてよいのは送信にしか使えない値だけ。dSYM のアップロード用のトークンは CI にだけ置く）。`environment`・`release`（`CFBundleShortVersionString`＋`CFBundleVersion`）を付ける
- 計測のラッパー：`struct AnalyticsEvent { let name: String; let properties: [String: Any] }` と、イベントごとの `static func`（下の「チェッカーの設定例」の見本の形。チェッカーが名前を拾えるように `.init(` ではなく `AnalyticsEvent(name:` と書く）。呼ぶ側は `Analytics.track(.signupCompleted(method: .apple))`
- ログイン・ログアウトで、エラー監視と計測の利用者 ID を付け外しする（アプリ内部の ID）
- `URLSession` のリクエストに `traceparent` か `X-Request-ID` を付ける（サーバーのログとつなぐ）

## 落とし穴

- `print` と `NSLog` は本番で役に立たない（`print` は Console に出ず、`NSLog` は値が丸見え）。
- `PrivacyInfo.xcprivacy`：SDK を足すと、収集するデータの申告（App Store のプライバシーの表示）も変わる。
- SwiftUI のプレビューとテストでは、エラー監視と計測を初期化しない（`XCODE_RUNNING_FOR_PREVIEWS`・テストの判定）。
- App Extension（Widget など）は別のプロセス。必要ならそこでも初期化する。

## チェッカーの設定例

計測の呼び出し（またはラッパーの定義）の見本。下の `event_calls` はこの形に当たる。

```swift
static func signupCompleted(method: SignupMethod) -> AnalyticsEvent {
  AnalyticsEvent(name: "signup_completed", properties: ["method": method.rawValue])
}
```

```json
{
  "code": {
    "dirs": ["App"],
    "event_calls": ["AnalyticsEvent\\(\\s*name:\\s*\"([a-z0-9_]+)\""],
    "forbidden": [
      { "pattern": "\\bprint\\(|\\bNSLog\\(", "message": "Logger を使ってください（observability/logging.md）", "allow": ["Tests/"] },
      { "pattern": "Analytics\\.logEvent\\(|Amplitude\\b.*\\.track\\(", "message": "計測はラッパー（AnalyticsEvent）を通してください", "allow": ["Analytics/AnalyticsClient\\.swift$"] }
    ]
  }
}
```

イベント名はラッパーの定義に 1 回だけ出る。チェッカーは「定義にあるイベントがトラッキングプランにあるか」と「active なのに定義がないか」を見る。
