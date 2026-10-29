// スキルから呼ぶ CLI。結果は JSON で出す。
//   node cli.mjs install <repo> [--base hig|shadcn] [--add <path,…>]
//       design-system.json（v2）がなければ作り、ひな形を置く。すでにあれば check.mjs だけを写し、
//       置いていないひな形を available に並べる（消した部品を戻さないため、--add で名前を挙げたものだけ置く）
//   node cli.mjs stage <repo> <段> <pending|approved>  段の進み具合を書く。承認したら、その下の承認済みの段は pending に戻す
//   node cli.mjs trace <repo> --from <ID|トークン>      影響を受けるもの（原則 → トークン・基礎・部品・パターン・文言）を下へたどる
//   node cli.mjs status <repo>                         チェックの結果に、段の進み具合と古くなった check.mjs を加えて出す
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CONFIG_PATH, REQUIRED, STAGES, collectTrace, flattenTokens, loadConfig, runCheck, traceFrom } from './check.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CHECK = join(ROOT, 'scripts', 'check.mjs')
const TEMPLATES = join(ROOT, 'templates')
const DS_DIR = dirname(CONFIG_PATH)
// 出力（⑤）は 2 段階目から。それまでは ① から ④ だけを進める段として扱う。
const ACTIVE_STAGES = STAGES.filter((s) => s !== 'outputs')

const posix = (p) => p.split(sep).join('/')

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((p) => statSync(join(dir, p)).isFile() && basename(p) !== '.DS_Store')
    .sort()
}

export function defaultConfig(base) {
  return {
    version: 2,
    ds_version: '1.0.0',
    base,
    stages: Object.fromEntries(STAGES.map((s) => [s, 'pending'])),
    product_principles: 'docs/product/principles.md',
    docs: ['README.md', 'principles.md', 'foundations.md', 'patterns.md', 'copy.md'].map((n) => `${DS_DIR}/${n}`),
    components: `${DS_DIR}/components`,
    tokens: `${DS_DIR}/tokens.json`,
    candidates: 'docs/design-candidates',
    outputs: {},
    protected_paths: [`${DS_DIR}/**`, 'docs/product/principles.md'],
    check: { command: `node ${DS_DIR}/check.mjs`, exclude: [] },
  }
}

function readConfigFile(repo) {
  const file = join(repo, CONFIG_PATH)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

function writeConfig(repo, config) {
  const file = join(repo, CONFIG_PATH)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
}

// 部品の仕様のひな形。<名前>.<土台>.md があれば、それを <名前>.md として使う。
export function componentTemplates(base) {
  const dir = join(TEMPLATES, 'components')
  const picked = new Map()
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const m = /^(.+?)(?:\.(\w+))?\.md$/.exec(f)
    if (m[2] && m[2] !== base) continue
    if (!m[2] && picked.has(m[1])) continue
    picked.set(m[1], join(dir, f))
  }
  return picked
}

// ひな形とアプリの中の置き場所の組（[プラグインの中のファイル, アプリの中の道のり]）。
function templateFiles(config) {
  return [
    [join(TEMPLATES, 'product', 'principles.md'), config.product_principles],
    ...filesUnder(join(TEMPLATES, 'docs')).map((f) => [join(TEMPLATES, 'docs', f), join(DS_DIR, f)]),
    [join(TEMPLATES, 'tokens', `${config.base}.json`), config.tokens],
    ...[...componentTemplates(config.base)].map(([name, from]) => [from, join(config.components, `${name}.md`)]),
    [join(TEMPLATES, 'candidates', 'README.md'), join(config.candidates, 'README.md')],
  ].map(([from, to]) => [from, posix(to)])
}

export function install(repo, { base, add = [] } = {}) {
  let config = readConfigFile(repo)
  const created = !config
  if (config && config.version !== 2) throw new Error(`${CONFIG_PATH} は v${config.version} です。v1 のアプリは、v1 からの移行ができるまで /design-system:* を使ってください`)
  if (!config) {
    if (!REQUIRED[base]) throw new Error('新しく作るときは --base hig か --base shadcn を渡してください')
    config = defaultConfig(base)
    writeConfig(repo, config)
  }
  const templates = templateFiles(config)
  const unknown = add.filter((p) => !templates.some(([, to]) => to === p))
  if (unknown.length) throw new Error(`--add に、ひな形のない道のりがあります: ${unknown.join(', ')}`)
  const copied = []
  const skipped = []
  const available = []
  for (const [from, to] of templates) {
    const abs = join(repo, to)
    if (existsSync(abs)) {
      if (created || add.includes(to)) skipped.push(to)
      continue
    }
    // 2 回目からは、名前を挙げたものだけ置く（消した部品の仕様や文書を、黙って戻さない）。
    if (!created && !add.includes(to)) {
      available.push(to)
      continue
    }
    mkdirSync(dirname(abs), { recursive: true })
    copyFileSync(from, abs)
    copied.push(to)
  }
  mkdirSync(join(repo, DS_DIR), { recursive: true })
  copyFileSync(CHECK, join(repo, DS_DIR, 'check.mjs'))
  const note = !created && base && base !== config.base ? `設定の base は ${config.base} のままです（--base ${base} は使っていません。土台を変えるのは update でのメジャーな変更）` : undefined
  return { config: created ? 'created' : 'kept', base: config.base, check: `${DS_DIR}/check.mjs`, copied, skipped, available, ...(note ? { note } : {}) }
}

export function stage(repo, name, state) {
  const config = loadConfig(repo)
  if (!STAGES.includes(name)) throw new Error(`段は ${STAGES.join('・')} のどれかです`)
  if (!['pending', 'approved'].includes(state)) throw new Error('状態は pending か approved です')
  config.stages = { ...Object.fromEntries(STAGES.map((s) => [s, 'pending'])), ...config.stages, [name]: state }
  const reset = []
  if (state === 'approved') {
    for (const lower of STAGES.slice(STAGES.indexOf(name) + 1)) {
      if (config.stages[lower] === 'approved') {
        config.stages[lower] = 'pending'
        reset.push(lower)
      }
    }
  }
  writeConfig(repo, config)
  return { stages: config.stages, reset }
}

export function trace(repo, from) {
  if (!from) throw new Error('--from <ID かトークンの道のり> を渡してください')
  const config = loadConfig(repo)
  const tokens = flattenTokens(JSON.parse(readFileSync(join(repo, config.tokens), 'utf8'))).tokens
  const t = collectTrace(repo, config, tokens)
  if (!t.P.has(from) && !t.D.has(from) && !tokens.has(from)) throw new Error(`${from} は原則の ID にもトークンにもありません`)
  // 部品の仕様は意味の段のトークンを指していないので、トークンから部品へはたどれない（1 段階目）。
  const note = tokens.has(from) ? 'トークンからたどれるのは、そのトークンを別名で使うトークンまで。部品への影響は、部品の仕様とトークンの $description を読んで判断する' : undefined
  return { from, affected: traceFrom(t, from), ...(note ? { note } : {}) }
}

export function status(repo) {
  const r = runCheck(repo)
  const config = loadConfig(repo)
  const vendored = join(repo, DS_DIR, 'check.mjs')
  if (!existsSync(vendored) || readFileSync(vendored, 'utf8') !== readFileSync(CHECK, 'utf8')) {
    r.stale.unshift(`${DS_DIR}/check.mjs がプラグインの版と違います（/product-design:update で写し直す）`)
  }
  // next は、この版で進められる段（① から ④）の中で、まだ承認されていない最初の段。すべて承認済みなら null。
  const next = ACTIVE_STAGES.find((s) => config.stages?.[s] !== 'approved') ?? null
  return { ...r, stages: config.stages, next }
}

function option(args, name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const USAGE = 'node cli.mjs install|stage|trace|status <repo> …'

export function main(argv) {
  const [command, repoArg, ...rest] = argv
  // <repo> を書き忘れて、--base などがリポジトリとみなされないように。
  if (!repoArg || repoArg.startsWith('--')) throw new Error(`使い方: ${USAGE}`)
  const repo = resolve(repoArg)
  switch (command) {
    case 'install':
      return install(repo, { base: option(argv, '--base'), add: option(argv, '--add')?.split(',').filter(Boolean) ?? [] })
    case 'stage':
      return stage(repo, rest[0], rest[1])
    case 'trace':
      return trace(repo, option(argv, '--from'))
    case 'status':
      return status(repo)
    default:
      throw new Error(`使い方: ${USAGE}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try {
    console.log(JSON.stringify(main(process.argv.slice(2)), null, 2))
  } catch (e) {
    console.error(e.message)
    process.exitCode = 1
  }
}
