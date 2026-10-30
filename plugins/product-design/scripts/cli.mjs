// スキルから呼ぶ CLI。結果は JSON で出す。
//   node cli.mjs install <repo> [--base hig|shadcn] [--add <path,…>]
//       design-system.json（v2）がなければ作り、ひな形を置く。すでにあれば check.mjs だけを写し、
//       置いていないひな形を available に並べる（消した部品を戻さないため、--add で名前を挙げたものだけ置く）。
//       HTML の出力（outputs.html）がなければ足して、そのひな形を置く。最後に tokens.css を作り直す
//   node cli.mjs stage <repo> <段> <pending|approved>  段の進み具合を書く。承認したら、その下の承認済みの段は pending に戻す
//   node cli.mjs trace <repo> --from <ID|トークン>      影響を受けるもの（原則 → トークン・基礎・部品・パターン・文言 → HTML の出力のファイル）を下へたどる
//   node cli.mjs tokens <repo>                         HTML の出力の tokens.css を tokens.json から作り直す
//   node cli.mjs screenshot <repo> [--pages <名前,…>]   HTML の見本のページを手元の Chrome でライトとダークで撮る（Chrome がなければ撮らずに知らせる）
//   node cli.mjs status <repo>                         チェックの結果に、段の進み具合と古くなった check.mjs を加えて出す
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CONFIG_PATH, REQUIRED, STAGES, collectTrace, flattenTokens, generateCss, loadConfig, runCheck, traceFrom, validateTokens } from './check.mjs'

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
    outputs: { html: { code: `${DS_DIR}/html` } },
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

// ひな形の道のりのうち、<名前>.<土台>.<拡張子> があれば、その土台ではそれを <名前>.<拡張子> として使う（ほかの土台のものは使わない）。
// 返すのは、置く道のり → プラグインの中のファイル。
export function pickForBase(dir, base) {
  const bases = Object.keys(REQUIRED).join('|')
  const named = new RegExp(`^(.*?)(?:\\.(${bases}))?(\\.[^./]+)$`)
  const picked = new Map()
  for (const f of filesUnder(dir)) {
    const m = named.exec(posix(f))
    if (m[2] && m[2] !== base) continue
    const key = m[1] + m[3]
    if (!m[2] && picked.has(key)) continue
    picked.set(key, join(dir, f))
  }
  return picked
}

// 部品の仕様のひな形（名前 → ファイル）。
export function componentTemplates(base) {
  return new Map([...pickForBase(join(TEMPLATES, 'components'), base)].filter(([k]) => k.endsWith('.md')).map(([k, f]) => [k.slice(0, -3), f]))
}

// ひな形とアプリの中の置き場所の組（[プラグインの中のファイル, アプリの中の道のり]）。
function templateFiles(config) {
  return [
    [join(TEMPLATES, 'product', 'principles.md'), config.product_principles],
    ...filesUnder(join(TEMPLATES, 'docs')).map((f) => [join(TEMPLATES, 'docs', f), join(DS_DIR, f)]),
    [join(TEMPLATES, 'tokens', `${config.base}.json`), config.tokens],
    ...[...componentTemplates(config.base)].map(([name, from]) => [from, join(config.components, `${name}.md`)]),
    [join(TEMPLATES, 'candidates', 'README.md'), join(config.candidates, 'README.md')],
    ...(config.outputs?.html ? [...pickForBase(join(TEMPLATES, 'html'), config.base)].map(([rel, from]) => [from, join(config.outputs.html.code, rel)]) : []),
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
  // HTML の出力はいつも作る。outputs.html のない設定（1 段階目で作ったもの）には足して、HTML のひな形をすべて置く。
  const htmlAdded = !config.outputs?.html
  if (htmlAdded) {
    config.outputs = { ...config.outputs, html: { code: `${DS_DIR}/html` } }
    writeConfig(repo, config)
  }
  const placeAll = (to) => created || (htmlAdded && to.startsWith(`${config.outputs.html.code}/`))
  const templates = templateFiles(config)
  const unknown = add.filter((p) => !templates.some(([, to]) => to === p))
  if (unknown.length) throw new Error(`--add に、ひな形のない道のりがあります: ${unknown.join(', ')}`)
  const copied = []
  const skipped = []
  const available = []
  for (const [from, to] of templates) {
    const abs = join(repo, to)
    if (existsSync(abs)) {
      if (placeAll(to) || add.includes(to)) skipped.push(to)
      continue
    }
    // 2 回目からは、名前を挙げたものだけ置く（消した部品の仕様や文書を、黙って戻さない）。
    if (!placeAll(to) && !add.includes(to)) {
      available.push(to)
      continue
    }
    mkdirSync(dirname(abs), { recursive: true })
    copyFileSync(from, abs)
    copied.push(to)
  }
  mkdirSync(join(repo, DS_DIR), { recursive: true })
  copyFileSync(CHECK, join(repo, DS_DIR, 'check.mjs'))
  const css = tokens(repo)
  const note = !created && base && base !== config.base ? `設定の base は ${config.base} のままです（--base ${base} は使っていません。土台を変えるのは update でのメジャーな変更）` : undefined
  return { config: created ? 'created' : 'kept', base: config.base, check: `${DS_DIR}/check.mjs`, copied, skipped, available, tokens: css, ...(htmlAdded && !created ? { html_added: true } : {}), ...(note ? { note } : {}) }
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
  // 部品の仕様はトークンを指さないので、トークンから部品へは HTML の出力の CSS（var(--…)）を通ってたどる。
  const note = tokens.has(from) && !config.outputs?.html ? 'HTML の出力がないので、トークンからたどれるのは、そのトークンを別名で使うトークンまで。部品への影響は、部品の仕様とトークンの $description を読んで判断する' : undefined
  return { from, affected: traceFrom(t, from), ...(note ? { note } : {}) }
}

// HTML の出力の tokens.css を作り直す。tokens.json に誤りがあれば書かない。
export function tokens(repo) {
  const config = loadConfig(repo)
  const code = config.outputs?.html?.code
  if (!code) throw new Error(`${CONFIG_PATH} に outputs.html がありません`)
  const root = JSON.parse(readFileSync(join(repo, config.tokens), 'utf8'))
  const { errors } = validateTokens(root, config.base)
  if (errors.length) return { written: [], errors }
  const file = posix(join(code, 'tokens.css'))
  mkdirSync(join(repo, code), { recursive: true })
  writeFileSync(join(repo, file), generateCss(root))
  return { written: [file], errors: [] }
}

// 手元の Chrome。$CHROME、macOS の決まった場所、PATH の順に探す。なければ null。
export function findChrome(env = process.env) {
  const found = (p) => p && existsSync(p) && statSync(p).isFile()
  if (found(env.CHROME)) return env.CHROME
  const mac = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
  const onPath = (env.PATH ?? '').split(delimiter).filter(Boolean).flatMap((d) => ['google-chrome', 'chromium', 'chromium-browser'].map((n) => join(d, n)))
  return [...mac, ...onPath].find(found) ?? null
}

// Chrome の窓は幅 500px より狭くできない（狭くすると、広く描いて右を切って撮る）。
const SHOT_WIDTH = 560
// 部品のページは <main> の data-height に見出しの分を足した高さで、一覧のページは決まった高さで撮る。
const HEADER_HEIGHT = 160
const INDEX_HEIGHT = 1200

// HTML の出力の見本のページを、ライトとダークで撮る（design-system/screenshots/html/<ページ>-<light|dark>.png）。
export function screenshot(repo, { pages, chrome = findChrome() } = {}) {
  const config = loadConfig(repo)
  const code = config.outputs?.html?.code
  if (!code) throw new Error(`${CONFIG_PATH} に outputs.html がありません`)
  const all = [['index', posix(join(code, 'index.html'))]]
  const dir = join(repo, code, 'components')
  if (existsSync(dir)) for (const f of readdirSync(dir).filter((n) => n.endsWith('.html')).sort()) all.push([f.slice(0, -5), posix(join(code, 'components', f))])
  const unknown = (pages ?? []).filter((p) => !all.some(([name]) => name === p))
  if (unknown.length) throw new Error(`見本のページがありません: ${unknown.join(', ')}`)
  const chosen = pages ? all.filter(([name]) => pages.includes(name)) : all
  if (!chrome) return { skipped: true, reason: 'Chrome が見つからないので撮っていません（$CHROME に Chrome の実行ファイルの場所を書くと撮れる）', shots: [] }

  const outDir = join(repo, DS_DIR, 'screenshots', 'html')
  mkdirSync(outDir, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'product-design-chrome-'))
  const shots = []
  try {
    for (const [page, file] of chosen) {
      const height = /data-height="(\d+)"/.exec(readFileSync(join(repo, file), 'utf8'))?.[1]
      const size = `--window-size=${SHOT_WIDTH},${height ? Number(height) + HEADER_HEIGHT : INDEX_HEIGHT}`
      for (const theme of ['light', 'dark']) {
        const out = posix(join(DS_DIR, 'screenshots', 'html', `${page}-${theme}.png`))
        const url = `${pathToFileURL(join(repo, file)).href}?theme=${theme}`
        const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, size, `--screenshot=${join(repo, out)}`, url], { encoding: 'utf8', timeout: 60_000 })
        if (r.status !== 0 || !existsSync(join(repo, out))) throw new Error(`${page}（${theme}）を撮れませんでした: ${r.error?.message ?? r.stderr}`)
        shots.push({ page, theme, path: out })
      }
    }
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
  return { shots }
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

const USAGE = 'node cli.mjs install|stage|trace|tokens|screenshot|status <repo> …'

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
    case 'tokens':
      return tokens(repo)
    case 'screenshot':
      return screenshot(repo, { pages: option(argv, '--pages')?.split(',').filter(Boolean) })
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
