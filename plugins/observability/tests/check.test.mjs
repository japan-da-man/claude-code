import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, PERSPECTIVES, runCheck, status } from '../scripts/check.mjs'
import { ALERTS, CODE, EVENTS, RUNBOOK, makeRepo, writeFiles } from './helpers.mjs'

const errors = (result) => result.findings.filter((f) => f.level === 'error').map((f) => `${f.file}:${f.rule}`)
const warnings = (result) => result.findings.filter((f) => f.level === 'warning').map((f) => `${f.file}:${f.rule}`)
const messages = (result) => result.findings.map((f) => f.message).join('\n')

function goodRepo(extra = {}) {
  return makeRepo({
    'observability/config.json': { version: 1, progress: ['scope', 'incident'], code: CODE },
    'observability/events.yaml': EVENTS,
    'observability/alerts.yaml': ALERTS,
    'observability/runbooks/api-error-rate-high.md': RUNBOOK,
    'observability/runbooks/_triage.md': '# 共通\n',
    'src/lib/logger.ts': 'console.log(JSON.stringify(entry))\n',
    'src/signup.ts': "import { track } from './lib/analytics'\ntrack('signup_completed', { method: 'email' })\n",
    ...extra,
  })
}

test('空のリポジトリは問題なし（設定がなくても既定で動く）', () => {
  const result = runCheck(makeRepo())
  assert.equal(result.ok, true)
  assert.deepEqual(result.findings, [])
})

test('揃ったリポジトリは問題なし。数を数える。直下の observability/（写した check.mjs）は読まない', () => {
  const result = runCheck(goodRepo({ 'observability/check.mjs': "console.log('x'); track('not_in_plan')\n" }))
  assert.deepEqual(errors(result), [])
  assert.equal(result.ok, true)
  assert.deepEqual(result.counts, { events: 2, slos: 1, alerts: 1, runbooks: 2, incidents: 0, files_scanned: 2 })
})

test('イベント: 名前の形・重複・必須の項目・status・型・enum の値', () => {
  const repo = goodRepo({
    'observability/events.yaml': `events:
  - name: SignupCompleted
    description: x
    owner: a
    status: active
    trigger: t
  - name: signup_completed
    status: live
    trigger: t
    properties:
      - name: Method
        type: text
      - name: plan
        type: enum
  - name: signup_completed
    description: x
    owner: a
    status: planned
    trigger: t
    replaced_by: nothing_here
`,
  })
  const result = runCheck(repo)
  const e = errors(result)
  for (const rule of ['event_name', 'events', 'property']) assert.ok(e.includes(`observability/events.yaml:${rule}`), rule)
  const m = messages(result)
  assert.match(m, /SignupCompleted: 名前が/)
  assert.match(m, /signup_completed: 名前が重複/)
  assert.match(m, /signup_completed: description がありません/)
  assert.match(m, /signup_completed: owner がありません/)
  assert.match(m, /status は planned/)
  assert.match(m, /signup_completed\.Method: 名前が/)
  assert.match(m, /signup_completed\.Method: type は/)
  assert.match(m, /signup_completed\.plan: enum には values/)
  assert.match(m, /replaced_by の「nothing_here」/)
})

test('個人情報: pii: true と、個人情報に見える名前を止める。pii_reviewed があれば通す', () => {
  const repo = goodRepo({
    'observability/events.yaml': `events:
  - name: profile_updated
    description: x
    owner: a
    status: planned
    trigger: t
    properties:
      - name: user_email
        type: string
        description: d
      - name: first_name
        type: string
        description: d
      - name: shipping_address
        type: string
        description: d
      - name: nickname
        type: string
        pii: true
        description: d
      - name: email_verified
        type: boolean
        pii_reviewed: 確認したかどうかだけでアドレスは含まない
        description: d
      - name: zip_prefix_count
        type: integer
        description: d
      - name: screen_name
        type: string
        description: d
`,
  })
  const pii = runCheck(repo).findings.filter((f) => f.rule === 'pii').map((f) => f.message.split(':')[0])
  assert.deepEqual(pii, ['profile_updated.user_email', 'profile_updated.first_name', 'profile_updated.shipping_address', 'profile_updated.nickname'])
})

test('共通のプロパティと同じ名前は警告', () => {
  const repo = goodRepo({
    'observability/events.yaml': `global_properties:
  - name: platform
    type: string
    description: d
events:
  - name: app_opened
    description: x
    owner: a
    status: planned
    trigger: t
    properties:
      - name: platform
        type: string
        description: d
`,
  })
  assert.ok(warnings(runCheck(repo)).includes('observability/events.yaml:property'))
})

test('SLO とアラート: 形・重要度・SLO の参照・runbook のありなしと節', () => {
  const repo = goodRepo({
    'observability/alerts.yaml': `slos:
  - id: API
    sli: x
  - id: checkout-success
    sli: x
    target: 100
    window: month
alerts:
  - id: a-one
    severity: critical
    slo: missing-slo
    condition: c
    notify: n
    runbook: observability/runbooks/nope.md
  - id: a-two
    severity: sev1
    notify: n
    runbook: observability/runbooks/thin.md
  - id: a-two
    severity: sev3
    condition: c
    notify: n
`,
    'observability/runbooks/thin.md': '# thin\n\n## 対処\n',
  })
  const result = runCheck(repo)
  const m = messages(result)
  assert.match(m, /SLO の id「API」/)
  assert.match(m, /checkout-success: target は/)
  assert.match(m, /checkout-success: window は/)
  assert.match(m, /a-one: severity は sev1/)
  assert.match(m, /a-one: slo の「missing-slo」がありません/)
  assert.match(m, /a-one: runbook の observability\/runbooks\/nope\.md がありません/)
  assert.match(m, /a-two: condition がありません/)
  assert.match(m, /a-two: id が重複/)
  assert.match(m, /a-two: runbook がありません/)
  assert.ok(errors(result).includes('observability/runbooks/thin.md:runbook'))
  assert.match(m, /節がありません: 影響の確かめ方、切り分け、エスカレーション/)
  // どこからも指されない runbook は警告（_ で始まるものは共通の手順なので除く）
  assert.ok(warnings(result).includes('observability/runbooks/api-error-rate-high.md:runbook'))
  assert.ok(!warnings(result).includes('observability/runbooks/_triage.md:runbook'))
})

test('障害の記録: 重要度・状態・resolved のポストモーテム・ファイル名', () => {
  const post = ['概要', '影響', '時系列', '原因', '対処', '再発防止'].map((s) => `## ${s}\n\n本文\n`).join('\n')
  const repo = goodRepo({
    'observability/incidents/README.md': '# 記録\n',
    'observability/incidents/2026-10-01-login-down.md': `---\nseverity: sev1\nstatus: resolved\nstarted_at: "2026-10-01 10:00"\n---\n\n# ログイン\n\n${post}`,
    'observability/incidents/2026-10-02-slow.md': '---\nseverity: sev2\nstatus: resolved\nstarted_at: "2026-10-02 10:00"\n---\n\n# 遅い\n\n## 概要\n',
    'observability/incidents/oops.md': '---\nseverity: high\nstatus: open\n---\n\n# x\n',
  })
  const result = runCheck(repo)
  assert.equal(result.counts.incidents, 3)
  const byFile = (file) => result.findings.filter((f) => f.file === `observability/incidents/${file}`).map((f) => `${f.level}:${f.message}`)
  assert.deepEqual(byFile('2026-10-01-login-down.md'), [])
  assert.match(byFile('2026-10-02-slow.md').join('\n'), /ポストモーテムの節が必要です: 影響、時系列、原因、対処、再発防止/)
  const oops = byFile('oops.md').join('\n')
  assert.match(oops, /warning:ファイル名は/)
  assert.match(oops, /severity は/)
  assert.match(oops, /status は/)
  assert.match(oops, /started_at がありません/)
})

test('コード: プランにないイベントは誤り、planned・deprecated を送ると警告、active を送っていないと警告。場所は行つき', () => {
  const repo = goodRepo({
    'observability/events.yaml': `events:
  - name: signup_completed
    description: x
    owner: a
    status: active
    trigger: t
  - name: item_viewed
    description: x
    owner: a
    status: planned
    trigger: t
  - name: old_thing_done
    description: x
    owner: a
    status: deprecated
    trigger: t
  - name: never_sent
    description: x
    owner: a
    status: active
    trigger: t
`,
    'src/a.ts': "// 1\ntrack('signup_completed', {})\ntrack(\n  \"unknown_event\",\n  {},\n)\ntrack('item_viewed')\ntrack('old_thing_done')\n",
  })
  const result = runCheck(repo)
  const code = result.findings.filter((f) => f.rule === 'code_event').map((f) => `${f.level} ${f.file}`)
  assert.deepEqual(code, ['error src/a.ts:3', 'warning src/a.ts:7', 'warning src/a.ts:8', 'warning observability/events.yaml'])
  assert.match(messages(result), /never_sent: active なのに/)
})

test('コード: 禁止の書き方は許可したパス以外で止める。level: warning、exclude、skip_dirs、拡張子', () => {
  const repo = makeRepo({
    'observability/config.json': {
      version: 1,
      code: {
        dirs: ['.'],
        extensions: ['.ts', '.mjs'],
        exclude: ['\\.test\\.ts$'],
        forbidden: [
          { pattern: 'console\\.log\\(', message: 'logger を使う', allow: ['src/lib/logger\\.ts$'] },
          { pattern: '^\\s*debugger', message: 'debugger を消す', level: 'warning' },
        ],
      },
    },
    'src/lib/logger.ts': 'console.log(1)\n',
    'src/app.ts': 'const a = 1\nconsole.log(a)\n  debugger\n',
    'src/app.test.ts': 'console.log(1)\n',
    'src/node_modules/x/index.js': 'console.log(1)\n',
    'src/readme.md': 'console.log(1)\n',
    'other/b.txt': 'console.log(1)\n',
  })
  // exclude を設定で置き換えても、src/observability/ のようなアプリのコードは読む
  writeFiles(repo, { 'src/observability/log.ts': 'console.log(1)\n', 'observability/check.mjs': 'console.log(1)\n' })
  const result = runCheck(repo)
  const found = result.findings.map((f) => `${f.level} ${f.file} ${f.message}`)
  assert.deepEqual(found, ['error src/app.ts:2 logger を使う', 'warning src/app.ts:3 debugger を消す', 'error src/observability/log.ts:1 logger を使う'])
  assert.equal(result.counts.files_scanned, 3)
})

test('設定: 読めない JSON・正規表現・グループのない event_calls・観点でない progress', () => {
  assert.equal(runCheck(makeRepo({ 'observability/config.json': '{ nope' })).errors, 1)
  const repo = makeRepo({
    'observability/config.json': { version: 1, progress: ['scope', 'nope'], code: { event_calls: ['track\\(', '(['], forbidden: [{ pattern: '[' }] } },
  })
  const m = messages(runCheck(repo))
  assert.match(m, /progress の「nope」は観点ではありません/)
  assert.match(m, /code\.event_calls\[1\] の正規表現が読めません/)
  assert.match(m, /code\.forbidden\[0\]\.pattern の正規表現が読めません/)
  assert.match(m, /グループ \( \) が必要です/)
  // (?: ) だけのものもグループとは数えない。名前つきのグループは数える
  const nc = makeRepo({ 'observability/config.json': { version: 1, code: { event_calls: ['track\\((?:x)'] } } })
  assert.match(messages(runCheck(nc)), /グループ/)
  const named = makeRepo({ 'observability/config.json': { version: 1, code: { event_calls: ["track\\('(?<name>[a-z_]+)'"] } } })
  assert.doesNotMatch(messages(runCheck(named)), /グループ/)
})

test('YAML の誤りは行番号つきで parse の誤りになる', () => {
  const repo = makeRepo({ 'observability/events.yaml': 'events:\n  - name: a_b\n    description: 注意: 上限あり\n' })
  const result = runCheck(repo)
  assert.deepEqual(errors(result), ['observability/events.yaml:parse'])
  assert.match(messages(result), /3 行目/)
})

test('status: 決めた観点・残り・次', () => {
  const s = status(goodRepo())
  assert.equal(s.installed, true)
  assert.deepEqual(s.progress.decided, ['scope', 'incident'])
  assert.equal(s.progress.next, 'logging')
  assert.equal(s.progress.remaining.length, PERSPECTIVES.length - 2)
  assert.equal(status(makeRepo()).installed, false)
  const done = makeRepo({ 'observability/config.json': { ...DEFAULT_CONFIG, progress: [...PERSPECTIVES].reverse() } })
  assert.deepEqual(status(done).progress, { decided: PERSPECTIVES, remaining: [], next: null })
})

test('global_properties・events・properties がリストでなくても落ちずに誤りになる', () => {
  const repo = makeRepo({
    'observability/events.yaml': `global_properties:
  app_version: string
events:
  - name: app_opened
    description: x
    owner: a
    status: active
    trigger: t
    properties:
      platform: string
  - name: app_closed
    description: x
    owner: a
    status: active
    trigger: t
    properties:
      - name: reason
        type: string
        description: d
`,
  })
  const m = messages(runCheck(repo))
  assert.match(m, /global_properties: リストにしてください/)
  assert.match(m, /app_opened: リストにしてください/)
})

test('コード: 空の pattern や空の文字に当たる正規表現は設定の誤りにして、その規則は使わない', () => {
  const repo = makeRepo({
    'observability/config.json': { version: 1, code: { event_calls: ['(x*)'], forbidden: [{ message: 'x' }, { pattern: '', message: 'y' }, { pattern: 'a?', message: 'z' }] } },
    'src/a.ts': 'abc\nd\n',
  })
  const result = runCheck(repo)
  assert.deepEqual(result.findings.map((f) => f.rule), ['config', 'config', 'config', 'config'])
  const m = messages(result)
  assert.match(m, /code\.forbidden\[0\]\.pattern がありません/)
  assert.match(m, /code\.forbidden\[1\]\.pattern がありません/)
  assert.match(m, /code\.forbidden\[2\]\.pattern が空の文字に当たります/)
  assert.match(m, /code\.event_calls\[0\] が空の文字に当たります/)
})

test('コード: | で並べた書き方は、当たったグループからイベント名を取る。Vue を読み、ドットで始まるディレクトリは読まない', () => {
  const repo = makeRepo({
    'observability/config.json': { version: 1, code: { event_calls: ["track\\('([a-z_]+)'\\)|logEvent\\(\"([a-z_]+)\"\\)"], forbidden: [{ pattern: 'console\\.log\\(', message: 'logger' }] } },
    'observability/events.yaml': EVENTS,
    'src/a.ts': "track('signup_completed')\nlogEvent(\"made_up_event\")\n",
    'src/Page.vue': '<script setup>\nconsole.log(1)\n</script>\n',
    '.yarn/releases/yarn.cjs': 'console.log(1)\n',
    'src/.cache/x.js': 'console.log(1)\n',
  })
  const result = runCheck(repo)
  const found = result.findings.filter((f) => f.rule !== 'code_event' || f.level === 'error').map((f) => `${f.rule} ${f.file}`)
  assert.deepEqual(found, ['code_forbidden src/Page.vue:2', 'code_event src/a.ts:2'])
  assert.match(messages(result), /made_up_event/)
})
