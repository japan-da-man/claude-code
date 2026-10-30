// スキルから呼ぶ CLI。結果は JSON で出す。
//   node cli.mjs detect <repo>               スタック（言語・フレームワーク）と、もう入っている計測・ログ・監視の道具を見つける
//   node cli.mjs install <repo> [--ci]       check.mjs を写し、ないものだけ設定とひな形を置く
//   node cli.mjs status <repo>               決めた観点と数に、写した check.mjs が古いかどうかを加えて出す
//   node cli.mjs check <repo>                チェック（observability/check.mjs --json と同じ）
//   node cli.mjs template <name>             テンプレートのパス（runbook / incident）
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_PATH, DEFAULT_CONFIG, runCheck, status as progress } from './check.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CHECK = join(ROOT, 'scripts', 'check.mjs')
const TEMPLATES = join(ROOT, 'templates')
export const VENDORED = 'observability/check.mjs'
const TEMPLATE_FILES = { runbook: 'runbook.md', incident: 'incident.md' }

const posix = (p) => p.split(sep).join('/')

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((p) => statSync(join(dir, p)).isFile() && !p.endsWith('.DS_Store'))
    .sort()
}

// ---------------------------------------------------------------- detect

const SKIP = new Set(['node_modules', '.git', 'Pods', 'build', 'dist', '.next', '.expo', 'vendor', 'DerivedData', '.gradle', 'venv', '.venv', 'target', 'coverage'])
const MAX_DEPTH = 4

// [ファイル名の正規表現, そのファイルがあれば分かるスタック（中身の条件つき）]
const STACK_RULES = [
  { file: /^package\.json$/, stacks: [['expo', /"expo"\s*:/], ['react-native', /"react-native"\s*:/], ['nextjs', /"next"\s*:/], ['web', /"(react-dom|vue|svelte|@angular\/core|nuxt|astro|@remix-run\/react)"\s*:/], ['node', /"(express|fastify|@nestjs\/core|hono|koa|@hapi\/hapi)"\s*:/]] },
  { file: /^(Podfile|Package\.swift|project\.yml|Project\.swift)$/, stacks: [['ios', /./]] },
  { file: /^project\.pbxproj$/, stacks: [['ios', /./]] },
  // 今の Android Studio のテンプレートは version catalog（alias(libs.plugins.android.application)）で書く
  { file: /^(build\.gradle|build\.gradle\.kts)$/, stacks: [['android', /com\.android\.(application|library)|libs\.plugins\.android\.(application|library)/], ['jvm', /org\.springframework\.boot|io\.ktor|io\.micronaut|io\.quarkus/]] },
  { file: /^pom\.xml$/, stacks: [['jvm', /./]] },
  { file: /^pubspec\.yaml$/, stacks: [['flutter', /sdk:\s*flutter/]] },
  { file: /^go\.mod$/, stacks: [['go', /./]] },
  { file: /^(pyproject\.toml|requirements[\w.-]*\.txt|Pipfile|setup\.py)$/, stacks: [['python', /./]] },
  { file: /^Gemfile$/, stacks: [['rails', /['"]rails['"]/], ['ruby', /./]] },
  { file: /^Cargo\.toml$/, stacks: [['rust', /./]] },
]

// [道具の id, 種類, 見つける正規表現]。マニフェスト（package.json・Podfile・gradle・pubspec など）の中身を見る
const TOOL_RULES = [
  ['sentry', 'errors', /@sentry\/|sentry-cocoa|getsentry\/sentry|io\.sentry|sentry_flutter|sentry-sdk|sentry-ruby|sentry-rails|getsentry\/sentry-go|"Sentry"|sentry =/i],
  ['crashlytics', 'errors', /crashlytics/i],
  ['bugsnag', 'errors', /bugsnag/i],
  ['datadog', 'apm', /@datadog\/|dd-trace|dd-sdk-|datadog_flutter|ddtrace|DataDog\/|datadog-ci|["']datadog["']/i],
  ['newrelic', 'apm', /newrelic|new-relic/i],
  ['opentelemetry', 'tracing', /opentelemetry|@vercel\/otel/i],
  ['prometheus', 'metrics', /prom-client|prometheus/i],
  ['micrometer', 'metrics', /micrometer/i],
  ['firebase-analytics', 'analytics', /firebase[-_/]?analytics|FirebaseAnalytics/i],
  ['amplitude', 'analytics', /amplitude/i],
  ['posthog', 'analytics', /posthog/i],
  ['mixpanel', 'analytics', /mixpanel/i],
  ['segment', 'analytics', /@segment\/|analytics-swift|analytics-kotlin|segment_analytics/i],
  ['pino', 'logging', /"pino"|"pino-http"/],
  ['winston', 'logging', /"winston"/],
  ['swift-log', 'logging', /apple\/swift-log/],
  ['timber', 'logging', /jakewharton\.timber|com\.jakewharton\.timber/i],
  ['structlog', 'logging', /structlog/],
  ['loguru', 'logging', /loguru/],
  ['zap', 'logging', /go\.uber\.org\/zap/],
  ['zerolog', 'logging', /rs\/zerolog/],
  ['lograge', 'logging', /lograge/],
  ['semantic_logger', 'logging', /semantic_logger|rails_semantic_logger/],
  ['logstash-encoder', 'logging', /logstash-logback-encoder/],
  ['dart-logger', 'logging', /^\s+logger:/m],
  ['web-vitals', 'metrics', /"web-vitals"/],
]

const MANIFEST = /^(package\.json|Podfile|Package\.swift|Package\.resolved|project\.pbxproj|build\.gradle(\.kts)?|libs\.versions\.toml|pom\.xml|pubspec\.yaml|go\.mod|pyproject\.toml|requirements[\w.-]*\.txt|Pipfile|Gemfile|Cargo\.toml|project\.yml)$/

function manifests(repo) {
  const out = []
  const visit = (dir, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        // *.xcodeproj の中の project.pbxproj は深さに数えない
        if (e.name.endsWith('.xcodeproj')) visit(abs, depth)
        else if (!SKIP.has(e.name) && !e.name.startsWith('.') && depth < MAX_DEPTH) visit(abs, depth + 1)
      } else if (e.isFile() && MANIFEST.test(e.name)) out.push(abs)
    }
  }
  visit(repo, 0)
  return out
}

// フレームワークを使わない Node のサーバー・ワーカー（素の http、Lambda、キューのワーカーなど）。
// 依存があって起動のしかた（start・dev・bin）があり、モノレポの親でない package.json
function plainNode(abs, text) {
  let pkg
  try {
    pkg = JSON.parse(text)
  } catch {
    return false
  }
  if (pkg.workspaces || ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json'].some((f) => existsSync(join(dirname(abs), f)))) return false
  const runnable = pkg.bin || pkg.scripts?.start || pkg.scripts?.dev
  return Boolean(runnable && pkg.dependencies && Object.keys(pkg.dependencies).length)
}

const JS_STACKS = ['expo', 'react-native', 'nextjs', 'web', 'node']

export function detect(repo) {
  const stacks = new Map()
  const tools = new Map()
  const nodeCandidates = []
  for (const abs of manifests(repo)) {
    const rel = posix(relative(repo, abs))
    const name = rel.split('/').pop()
    let text
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    // アプリのディレクトリ（xcodeproj の中なら、その外）
    const dir = posix(dirname(rel)).replace(/\/?[^/]*\.xcodeproj$/, '') || '.'
    if (name === 'package.json' && plainNode(abs, text)) nodeCandidates.push({ dir, rel })
    for (const rule of STACK_RULES) {
      if (!rule.file.test(name)) continue
      for (const [id, re] of rule.stacks) {
        if (!re.test(text)) continue
        const key = `${id}@${dir}`
        if (!stacks.has(key)) stacks.set(key, { id, dir, evidence: [] })
        stacks.get(key).evidence.push(rel)
        // ruby は rails があれば言わない
        if (id === 'rails') break
      }
    }
    for (const [id, category, re] of TOOL_RULES) {
      if (!re.test(text)) continue
      if (!tools.has(id)) tools.set(id, { id, category, evidence: [] })
      if (!tools.get(id).evidence.includes(rel)) tools.get(id).evidence.push(rel)
    }
  }
  for (const { dir, rel } of nodeCandidates) {
    if (![...stacks.values()].some((s) => s.dir === dir && JS_STACKS.includes(s.id))) stacks.set(`node@${dir}`, { id: 'node', dir, evidence: [rel] })
  }
  // Expo / React Native / Flutter のアプリには ios・android のディレクトリもある。同じ場所の下にあるネイティブは、そのアプリの一部として扱う
  const list = [...stacks.values()]
  const rn = list.filter((s) => s.id === 'expo' || s.id === 'react-native' || s.id === 'flutter')
  const expoDirs = new Set(list.filter((s) => s.id === 'expo').map((s) => s.dir))
  const result = list.filter((s) => {
    if (s.id === 'react-native' && expoDirs.has(s.dir)) return false
    if (s.id === 'web' && (expoDirs.has(s.dir) || list.some((n) => n.id === 'nextjs' && n.dir === s.dir))) return false
    if ((s.id === 'ios' || s.id === 'android') && rn.some((r) => s.dir === `${r.dir === '.' ? '' : r.dir + '/'}${s.id}` || s.dir.startsWith(`${r.dir === '.' ? '' : r.dir + '/'}${s.id}/`))) return false
    if (s.id === 'ruby' && list.some((n) => n.id === 'rails' && n.dir === s.dir)) return false
    // Android のアプリが Ktor のクライアントを使っていても、JVM のサーバーではない
    if (s.id === 'jvm' && list.some((n) => n.id === 'android' && n.dir === s.dir)) return false
    return true
  })
  const order = ['ios', 'android', 'expo', 'react-native', 'flutter', 'nextjs', 'web', 'node', 'python', 'go', 'rails', 'ruby', 'jvm', 'rust']
  result.sort((a, b) => a.dir.localeCompare(b.dir) || order.indexOf(a.id) - order.indexOf(b.id))
  const ci = ['.github/workflows', '.circleci', 'bitrise.yml', 'codemagic.yaml', 'eas.json', 'fastlane', 'vercel.json', 'netlify.toml', 'fly.toml', 'app.yaml', 'Dockerfile', 'serverless.yml', 'cdk.json']
    .filter((p) => existsSync(join(repo, p)))
  return {
    stacks: result,
    tools: [...tools.values()].sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id)),
    delivery: ci,
    references: [...new Set(result.map((s) => reference(s.id)))],
  }
}

// スタックの id から、定番をまとめた references/stacks/ のファイル
export function reference(id) {
  const map = { 'react-native': 'expo-react-native', expo: 'expo-react-native', nextjs: 'web', ruby: 'rails' }
  const name = map[id] ?? id
  const file = join(ROOT, 'references', 'stacks', `${name}.md`)
  return existsSync(file) ? posix(relative(ROOT, file)) : 'references/stacks/other.md'
}

// ---------------------------------------------------------------- install / status

export function install(repo, { ci = false } = {}) {
  const copied = []
  const updated = []
  const skipped = []

  const vendored = join(repo, VENDORED)
  mkdirSync(dirname(vendored), { recursive: true })
  if (!existsSync(vendored)) {
    copyFileSync(CHECK, vendored)
    copied.push(VENDORED)
  } else if (readFileSync(vendored, 'utf8') !== readFileSync(CHECK, 'utf8')) {
    copyFileSync(CHECK, vendored)
    updated.push(VENDORED)
  }

  const place = (from, to) => {
    const abs = join(repo, to)
    if (existsSync(abs)) return skipped.push(to)
    mkdirSync(dirname(abs), { recursive: true })
    copyFileSync(from, abs)
    copied.push(to)
  }

  if (!existsSync(join(repo, CONFIG_PATH))) {
    writeFileSync(join(repo, CONFIG_PATH), JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n')
    copied.push(CONFIG_PATH)
  } else skipped.push(CONFIG_PATH)

  const repoTemplates = join(TEMPLATES, 'repo')
  for (const rel of filesUnder(repoTemplates)) place(join(repoTemplates, rel), `observability/${posix(rel)}`)

  if (ci) place(join(TEMPLATES, 'ci', 'observability.yml'), '.github/workflows/observability.yml')

  return { copied, updated, skipped }
}

export function status(repo) {
  const vendored = join(repo, VENDORED)
  const check = !existsSync(vendored) ? 'missing' : readFileSync(vendored, 'utf8') === readFileSync(CHECK, 'utf8') ? 'ok' : 'stale'
  return { ...progress(repo), vendored_check: check }
}

export function templatePath(name) {
  const file = TEMPLATE_FILES[name]
  if (!file) throw new Error(`テンプレートは ${Object.keys(TEMPLATE_FILES).join(' / ')} のどれかです`)
  return join(TEMPLATES, file)
}

function main(argv) {
  const args = [...argv]
  const flag = (name) => {
    const i = args.indexOf(name)
    if (i === -1) return false
    args.splice(i, 1)
    return true
  }
  const ci = flag('--ci')
  const cmd = args.shift()
  const out = (v) => console.log(JSON.stringify(v, null, 2))
  if (cmd === 'template') return out({ path: templatePath(args[0]) }), 0
  const repo = resolve(args.shift() ?? '.')
  switch (cmd) {
    case 'detect':
      out(detect(repo))
      return 0
    case 'install':
      out(install(repo, { ci }))
      return 0
    case 'status':
      out(status(repo))
      return 0
    case 'check': {
      const result = runCheck(repo)
      out(result)
      return result.ok ? 0 : 1
    }
    default:
      console.error('使い方: node cli.mjs detect|install|status|check <repo> …  /  node cli.mjs template <name>')
      return 2
  }
}

const isMain = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    console.error(`observability: ${e.message}`)
    process.exitCode = 2
  }
}
