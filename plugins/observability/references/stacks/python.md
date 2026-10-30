# Python（FastAPI・Django・Flask）

> SDK の名前・API・バージョンは変わる。入れる前に、公式ドキュメントとパッケージの最新版を確かめる。

## 定番

| 観点 | 第一候補 | ほか | メモ |
| :- | :- | :- | :- |
| ログ | structlog（JSON の renderer） | 標準の `logging` ＋ python-json-logger、loguru | 標準の `logging` を使うライブラリのログも同じ形に揃える |
| リクエストの文脈 | `structlog.contextvars`（`contextvars`）に `request_id`・`trace_id` | Django は middleware、FastAPI は middleware か dependency | |
| 障害 | Sentry（`sentry-sdk`。Django・FastAPI・Celery の連携は自動で有効） | Datadog（ddtrace） | |
| メトリクス・トレース | OpenTelemetry（`opentelemetry-distro` と `opentelemetry-instrument` の自動計装） | `prometheus-client`、ddtrace | |
| 計測（サーバー側） | 計測の道具のサーバー用 SDK | | |

## 置くもの

- `app/logging.py`：structlog の設定（本番は JSON、開発は見やすい形）、伏せるキー（`password`・`token`・`authorization`・`cookie`）を消す processor
- リクエストのミドルウェア：`X-Request-ID` か `traceparent` を受け取る（なければ作る）、contextvars に入れる、終わりに 1 行
- Django は `settings.LOGGING` に、gunicorn / uvicorn のアクセスログも同じ形にする
- ワーカー（Celery・RQ）のジョブにも `request_id` を引き継ぐ

## 落とし穴

- `print` は標準出力に出るが、レベルも項目もない。
- `logger.info(f"user {email} …")` のように値を文に埋め込まない（検索できず、個人情報も混じる）。`logger.info("signed_in", user_id=…)`。
- Django の `DEBUG = True` のエラー画面は本番で出さない。

## チェッカーの設定例

計測の呼び出し（またはラッパーの定義）の見本。下の `event_calls` はこの形に当たる。

```python
track("signup_completed", method="email")
```

```json
{
  "code": {
    "dirs": ["app"],
    "extensions": [".py"],
    "exclude": ["(^|/)tests?/", "_test\\.py$"],
    "event_calls": ["\\btrack\\(\\s*['\"]([a-z0-9_]+)['\"]"],
    "forbidden": [
      { "pattern": "\\bprint\\(", "message": "logger を使ってください（observability/logging.md）", "allow": ["(^|/)scripts/", "manage\\.py$"] },
      { "pattern": "log(ger)?\\.\\w+\\(\\s*f['\"]", "message": "値は文に埋め込まず、キーワード引数で渡してください", "level": "warning" }
    ]
  }
}
```
