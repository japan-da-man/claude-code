import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detect, install, reference, status, templatePath, VENDORED } from '../scripts/cli.mjs'
import { parseMarkdown, parseYaml, runCheck } from '../scripts/check.mjs'
import { makeRepo, writeFiles } from './helpers.mjs'

const CLI = fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('install: check.mjs を写し、設定とひな形を置く。置いた直後のチェックは通る。2 回目は何も上書きしない', () => {
  const repo = makeRepo({ 'observability/logging.md': '# 既存のログの決まり\n' })
  const first = install(repo)
  for (const f of [VENDORED, 'observability/config.json', 'observability/README.md', 'observability/events.yaml', 'observability/alerts.yaml', 'observability/runbooks/_triage.md', 'observability/incidents/README.md']) {
    assert.ok(first.copied.includes(f), f)
  }
  assert.deepEqual(first.skipped, ['observability/logging.md'])
  assert.equal(readFileSync(join(repo, 'observability/logging.md'), 'utf8'), '# 既存のログの決まり\n')
  assert.equal(existsSync(join(repo, '.github/workflows/observability.yml')), false)
  const result = runCheck(repo)
  assert.equal(result.ok, true, JSON.stringify(result.findings))
  assert.deepEqual(result.findings, [])

  const second = install(repo, { ci: true })
  assert.deepEqual(second.updated, [])
  assert.deepEqual(second.copied, ['.github/workflows/observability.yml'])
})

test('status: 写した check.mjs が古ければ stale、なければ missing', () => {
  const repo = makeRepo()
  install(repo)
  assert.equal(status(repo).vendored_check, 'ok')
  writeFileSync(join(repo, VENDORED), '// old\n')
  assert.equal(status(repo).vendored_check, 'stale')
  assert.deepEqual(install(repo).updated, [VENDORED])
  assert.equal(status(makeRepo()).vendored_check, 'missing')
})

test('写した check.mjs はプラグインなしで動き、誤りで終了コード 1 を返す', () => {
  const repo = makeRepo()
  install(repo)
  const ok = spawnSync(process.execPath, [join(repo, VENDORED), repo], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /問題なし/)
  writeFiles(repo, { 'observability/events.yaml': 'events:\n  - name: Bad\n' })
  const ng = spawnSync(process.execPath, [join(repo, VENDORED), repo, '--json'], { encoding: 'utf8' })
  assert.equal(ng.status, 1)
  assert.equal(JSON.parse(ng.stdout).ok, false)
  const st = spawnSync(process.execPath, [join(repo, VENDORED), 'status', repo], { encoding: 'utf8' })
  assert.equal(JSON.parse(st.stdout).progress.next, 'scope')
})

test('detect: Expo のモノレポ。Expo の中の ios・android は別のスタックにしない。道具を種類つきで', () => {
  const repo = makeRepo({
    'package.json': { name: 'root', private: true, workspaces: ['apps/*'] },
    'apps/mobile/package.json': { dependencies: { expo: '~54.0.0', 'react-native': '0.81.0', '@sentry/react-native': '7.0.0', 'posthog-react-native': '4.0.0' } },
    'apps/mobile/ios/Podfile': "target 'App' do\nend\n",
    'apps/mobile/ios/App.xcodeproj/project.pbxproj': '// pbx\n',
    'apps/mobile/android/app/build.gradle': "apply plugin: 'com.android.application'\n",
    'apps/api/package.json': { dependencies: { fastify: '5.0.0', pino: '9.0.0', '@opentelemetry/sdk-node': '0.200.0' } },
    'apps/web/package.json': { dependencies: { next: '15.0.0', react: '19.0.0', 'react-dom': '19.0.0', '@sentry/nextjs': '9.0.0' } },
    'node_modules/expo/package.json': { dependencies: { expo: '1' } },
    '.github/workflows/ci.yml': 'on: push\n',
    'apps/mobile/eas.json': '{}',
  })
  const d = detect(repo)
  assert.deepEqual(d.stacks.map((s) => `${s.id}@${s.dir}`), ['node@apps/api', 'expo@apps/mobile', 'nextjs@apps/web'])
  assert.deepEqual(d.tools.map((t) => `${t.category}:${t.id}`), ['analytics:posthog', 'errors:sentry', 'logging:pino', 'tracing:opentelemetry'])
  assert.deepEqual(d.tools.find((t) => t.id === 'sentry').evidence, ['apps/mobile/package.json', 'apps/web/package.json'])
  assert.deepEqual(d.delivery, ['.github/workflows'])
  assert.deepEqual(d.references, ['references/stacks/node.md', 'references/stacks/expo-react-native.md', 'references/stacks/web.md'])
})

test('detect: ネイティブの iOS・Android、Flutter、Go、Python、Rails、Spring、Rust', () => {
  const repo = makeRepo({
    'ios/Shop.xcodeproj/project.pbxproj': 'repositoryURL = "https://github.com/getsentry/sentry-cocoa";\nFirebaseCrashlytics\n',
    'android/app/build.gradle.kts': 'plugins { id("com.android.application") }\nimplementation("com.jakewharton.timber:timber:5.0.1")\n',
    'flutter_app/pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n  sentry_flutter: ^9.0.0\n  logger: ^2.0.0\n',
    'services/go/go.mod': 'module x\nrequire go.opentelemetry.io/otel v1.0.0\n',
    'services/py/pyproject.toml': '[project]\ndependencies = ["fastapi", "structlog", "sentry-sdk"]\n',
    'services/rb/Gemfile': "gem 'rails'\ngem 'lograge'\n",
    'services/java/pom.xml': '<artifactId>spring-boot-starter-web</artifactId><artifactId>micrometer-registry-prometheus</artifactId>',
    'tools/rs/Cargo.toml': '[package]\nname = "x"\n',
  })
  const d = detect(repo)
  assert.deepEqual(d.stacks.map((s) => `${s.id}@${s.dir}`), [
    'android@android/app',
    'flutter@flutter_app',
    'ios@ios',
    'go@services/go',
    'jvm@services/java',
    'python@services/py',
    'rails@services/rb',
    'rust@tools/rs',
  ])
  const ids = d.tools.map((t) => t.id)
  for (const id of ['sentry', 'crashlytics', 'timber', 'opentelemetry', 'structlog', 'lograge', 'micrometer', 'prometheus', 'dart-logger']) assert.ok(ids.includes(id), id)
  assert.ok(d.references.includes('references/stacks/other.md'))
  assert.ok(d.references.includes('references/stacks/ios.md'))
})

test('detect: Flutter の中の ios・android は別のスタックにしない', () => {
  const repo = makeRepo({
    'pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n',
    'ios/Runner.xcodeproj/project.pbxproj': '// pbx\n',
    'ios/Podfile': "target 'Runner' do\nend\n",
    'android/app/build.gradle.kts': 'plugins { id("com.android.application") }\n',
  })
  assert.deepEqual(detect(repo).stacks.map((s) => `${s.id}@${s.dir}`), ['flutter@.'])
  assert.deepEqual(detect(repo).references, ['references/stacks/flutter.md'])
})

test('detect: version catalog で書いた Android。Ktor のクライアントを使っても JVM にしない', () => {
  const repo = makeRepo({
    'app/build.gradle.kts': 'plugins {\n  alias(libs.plugins.android.application)\n}\ndependencies {\n  implementation("io.ktor:ktor-client-okhttp:3.0.0")\n}\n',
    'gradle/libs.versions.toml': '[plugins]\nandroid-application = { id = "com.android.application" }\n',
    'server/build.gradle.kts': 'plugins { id("io.ktor.plugin") }\n',
  })
  assert.deepEqual(detect(repo).stacks.map((s) => `${s.id}@${s.dir}`), ['android@app', 'jvm@server'])
})

test('detect: フレームワークのない Node のサーバー・ワーカーも node。モノレポの親とライブラリは数えない', () => {
  const repo = makeRepo({
    'package.json': { private: true, workspaces: ['apps/*', 'packages/*'], dependencies: { zod: '3' }, scripts: { dev: 'turbo dev' } },
    'apps/worker/package.json': { dependencies: { bullmq: '5' }, scripts: { start: 'node dist/index.js' } },
    'apps/lambda/package.json': { dependencies: { '@aws-sdk/client-s3': '3' }, bin: { handler: 'dist/h.js' } },
    'apps/api/package.json': { dependencies: { express: '5' }, scripts: { start: 'node .' } },
    'packages/ui/package.json': { dependencies: { clsx: '2' } },
    'tools/pnpm/package.json': { dependencies: { x: '1' }, scripts: { dev: 'x' } },
    'tools/pnpm/pnpm-workspace.yaml': 'packages: []\n',
  })
  assert.deepEqual(detect(repo).stacks.map((s) => `${s.id}@${s.dir}`), ['node@apps/api', 'node@apps/lambda', 'node@apps/worker'])
})

test('reference: スタックごとの参照があり、どれも読める', () => {
  for (const id of ['ios', 'android', 'expo', 'react-native', 'flutter', 'nextjs', 'web', 'node', 'python', 'go', 'rails', 'ruby', 'jvm']) {
    const rel = reference(id)
    assert.notEqual(rel, 'references/stacks/other.md', id)
    assert.ok(existsSync(join(ROOT, rel)), rel)
  }
  assert.equal(reference('elixir'), 'references/stacks/other.md')
})

test('参照のチェッカーの設定例は、そのまま config に入れて読め、見本の呼び出しからイベント名を拾い、見本を禁止しない', () => {
  for (const id of ['ios', 'android', 'expo', 'flutter', 'web', 'node', 'python', 'go', 'rails', 'jvm']) {
    const text = readFileSync(join(ROOT, reference(id)), 'utf8')
    const section = text.slice(text.indexOf('## チェッカーの設定例'))
    const m = section.match(/```(\w+)\n([\s\S]*?)```\s*```json\n([\s\S]*?)```/)
    assert.ok(m, `${id} に見本と設定例がない`)
    const [, , sample, json] = m
    const config = JSON.parse(json)
    // 見本を、設定の dirs の 1 つ目の下に、設定の拡張子で置く
    const ext = (config.code.extensions ?? ['.ts'])[0]
    const ext2 = { ios: '.swift', android: '.kt', flutter: '.dart', jvm: '.kt' }[id] ?? ext
    const dir = config.code.dirs[0] === '.' ? 'pkg' : config.code.dirs[0]
    const repo = makeRepo({
      'observability/config.json': { version: 1, ...config },
      [`${dir}/sample${ext2}`]: sample,
      'observability/events.yaml': 'events: []\n',
    })
    const result = runCheck(repo)
    assert.deepEqual(result.findings.filter((f) => f.rule === 'config'), [], id)
    assert.deepEqual(result.findings.filter((f) => f.rule === 'code_forbidden'), [], id)
    const found = result.findings.filter((f) => f.rule === 'code_event').map((f) => f.message)
    assert.ok(found.length >= 1, `${id}: 見本からイベント名を拾えない`)
    for (const msg of found) assert.match(msg, /イベント「[a-z]+(_[a-z]+)+」がトラッキングプラン/, id)
  }
})

test('テンプレート: runbook と障害の記録はチェッカーの節を満たす', () => {
  const runbook = parseMarkdown(readFileSync(templatePath('runbook'), 'utf8'))
  for (const s of ['影響の確かめ方', '切り分け', '対処', 'エスカレーション']) assert.ok(runbook.headings.includes(s), s)
  const incident = parseMarkdown(readFileSync(templatePath('incident'), 'utf8'))
  for (const s of ['概要', '影響', '時系列', '原因', '対処', '再発防止']) assert.ok(incident.headings.includes(s), s)
  assert.equal(incident.data.status, 'investigating')
  assert.throws(() => templatePath('nope'))
  for (const f of ['events.yaml', 'alerts.yaml']) parseYaml(readFileSync(join(ROOT, 'templates/repo', f), 'utf8'))
})

test('CLI: JSON を出し、check は誤りで終了コード 1、使い方の誤りは 2', () => {
  const repo = makeRepo()
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  // フラグはどこに書いてもよい
  const inst = run('install', '--ci', repo)
  assert.equal(inst.status, 0, inst.stderr)
  assert.ok(JSON.parse(inst.stdout).copied.includes('.github/workflows/observability.yml'))
  assert.equal(JSON.parse(run('detect', repo).stdout).stacks.length, 0)
  assert.equal(run('check', repo).status, 0)
  writeFiles(repo, { 'observability/alerts.yaml': 'alerts:\n  - id: x\n' })
  assert.equal(run('check', repo).status, 1)
  assert.match(JSON.parse(run('template', 'runbook').stdout).path, /templates\/runbook\.md$/)
  assert.equal(run('nope').status, 2)
})
