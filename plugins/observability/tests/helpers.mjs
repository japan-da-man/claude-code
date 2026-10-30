import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export function makeRepo(files = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'observability-'))
  writeFiles(repo, files)
  return repo
}

export function writeFiles(repo, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
}

export const RUNBOOK = `# API のエラー率

## 影響の確かめ方

1. ダッシュボード

## 切り分け

1. デプロイ

## 対処

1. ロールバック

## エスカレーション

- リーダー
`

export const EVENTS = `global_properties:
  - name: app_version
    type: string
    description: アプリのバージョン
events:
  - name: signup_completed
    description: 会員登録が終わった
    owner: growth
    status: active
    trigger: 完了の画面が出たとき
    properties:
      - name: method
        type: enum
        values: [email, apple]
        description: 登録の方法
  - name: item_viewed
    description: 商品を見た
    owner: shop
    status: planned
    trigger: 詳細の画面が出たとき
`

export const ALERTS = `slos:
  - id: api-availability
    sli: 5xx を返さなかった割合
    target: 99.9
    window: 30d
alerts:
  - id: api-error-rate-high
    severity: sev2
    slo: api-availability
    condition: 5 分間の 5xx が 2% を超える
    notify: "#alerts"
    runbook: observability/runbooks/api-error-rate-high.md
`

export const CODE = {
  event_calls: ["\\btrack\\(\\s*['\"]([a-z0-9_]+)['\"]"],
  forbidden: [{ pattern: 'console\\.log\\(', message: 'logger を使う', allow: ['src/lib/logger\\.ts$'] }],
}
