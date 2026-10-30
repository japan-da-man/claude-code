// スキルから呼ぶ CLI。結果は JSON で出す。
//   node cli.mjs install <repo> [--base hig|shadcn] [--add <path,…>]
//       design-system.json（v2）がなければ作り、ひな形を置く。すでにあれば check.mjs だけを写し、
//       置いていないひな形を available に並べる（消した部品を戻さないため、--add で名前を挙げたものだけ置く）。
//       HTML の出力（outputs.html）がなければ足して、そのひな形を置く。最後に tokens.css を作り直す
//   node cli.mjs stage <repo> <段> <pending|approved>  段の進み具合を書く。承認したら、その下の承認済みの段は pending に戻す
//   node cli.mjs trace <repo> --from <ID|トークン>      影響を受けるもの（原則 → トークン・基礎・部品・パターン・文言 → HTML の出力のファイル）を下へたどる
//   node cli.mjs tokens <repo>                         HTML の出力の tokens.css を tokens.json から作り直す
//   node cli.mjs screenshot <repo> [--pages <名前,…>]   HTML の見本のページを手元の Chrome でライトとダークで撮る（Chrome がなければ撮らずに知らせる）
//   node cli.mjs artifact-stage <repo> <dir> [--title <名前>] [--index <今の索引>] [--by <名前>]
//       Claude の Design System に写すファイルを <dir>/project/ に並べる（トークンは Design System の形に変える）
//   node cli.mjs artifact-done <repo> <url>            写した Artifact の url と中身のハッシュを design-system.json に書く
//   node cli.mjs status <repo>                         チェックの結果に、段の進み具合と古くなった check.mjs を加えて出す
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CONFIG_PATH, REQUIRED, STAGES, artifactHash, collectTrace, cssDeclarations, cssFamily, deepResolve, flattenTokens, generateCss, isDeprecated, loadConfig, parseFrontMatter, runCheck, traceFrom, typeOf, validateTokens } from './check.mjs'

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

// ---------------------------------------------------------------------------
// Claude の Design System（Artifact の型）への写し

// Design System のトークンの族（color と type 以外は { tokens: [{ name, value, usage }] }）。余白は spacing と呼ぶ。
const DS_FAMILY = { space: 'spacing' }
const DS_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

// DTCG の tokens.json を、Design System が読む一覧の形にする。意味の段だけを、解決した値で渡す。
// 名前は tokens.css の変数の名前から -- を外したもの（Design System のページが作る CSS 変数と揃う）。
export function toDesignSystemTokens(root, { title, base, ds_version, tokens: file = `${DS_DIR}/tokens.json` }) {
  const { tokens } = flattenTokens(root)
  const out = {
    name: title,
    version: 1,
    meta: { source: 'product-design', base, ...(ds_version ? { ds_version } : {}), tokens: file },
    color: { themes: [{ id: 'light', name: 'Light' }, { id: 'dark', name: 'Dark' }], tokens: [] },
    type: { fonts: [], families: {}, groups: [] },
  }
  const styles = []
  for (const t of tokens.values()) {
    if (t.tier !== 'semantic') continue
    const retired = isDeprecated(t.deprecated) ? `（廃止${typeof t.deprecated === 'string' ? `: ${t.deprecated}` : ''}）` : ''
    const usage = retired + (t.description ?? '')
    const note = usage ? { usage } : {}
    const type = typeOf(tokens, t)
    if (type === 'typography') {
      const v = deepResolve(tokens, t.value)
      if (!v) continue
      const alias = /^\{(?:.*\.)?([^.{}]+)\}$/.exec(t.value?.fontFamily ?? '')
      const stack = cssFamily(v.fontFamily)
      const family = alias?.[1].toLowerCase() ?? Object.keys(out.type.families).find((k) => out.type.families[k] === stack) ?? `family-${Object.keys(out.type.families).length + 1}`
      out.type.families[family] = stack
      const name = t.path.split('.').slice(1).join('-')
      styles.push({ family, style: { name, fontSize: `${v.fontSize.value}${v.fontSize.unit}`, lineHeight: v.lineHeight, fontWeight: v.fontWeight, letterSpacing: `${v.letterSpacing.value}${v.letterSpacing.unit}`, ...note } })
      continue
    }
    const [entry] = Object.entries(cssDeclarations(tokens, t))
    if (!entry) continue
    const [variable, [light, dark]] = entry
    const family = type === 'color' ? 'color' : (DS_FAMILY[t.group] ?? t.group)
    const value = type === 'color' || light !== dark ? { light, dark } : light
    ;(out[family] ??= { tokens: [] }).tokens.push({ name: variable.slice(2), value, ...note })
  }
  if (styles.length) {
    const family = styles[0].family
    out.type.groups.push({ name: 'Text', family, styles: styles.map((s) => (s.family === family ? s.style : { ...s.style, family: s.family })) })
  }
  const names = Object.entries(out).filter(([k, v]) => k !== 'type' && Array.isArray(v?.tokens)).flatMap(([, v]) => v.tokens.map((x) => x.name))
  const bad = names.filter((n, i) => !DS_NAME.test(n) || names.indexOf(n) !== i)
  if (bad.length) throw new Error(`Design System に渡せない名前か、族をまたいで重なる名前があります: ${[...new Set(bad)].join(', ')}`)
  return out
}

const pascal = (name) => name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('')

// Design System の README に足す節。写したものだけを読む人（Claude Design など）への決まり。
function claudeDesignRules(config) {
  return `

## Claude Design で案を作るときの決まり

- この Design System の部品とトークンだけで案を組む。色・文字・余白の値を直に書かない。
- 部品の見本は \`components/bundle.css\` の \`ds-*\` のクラスで書いてある。案でも同じクラスとトークンの CSS 変数を使う。
- 足りないものがあれば、ある部品とトークンで仮の形を組んで案は先に進め、案の下に「部品の候補」として、どの画面で、何のために、何が足りないかを書く。

## この Design System について

- 正はアプリのリポジトリ（\`design-system/\`）で、ここはそこから一方向に写したもの。このページでは直せない。
- 変えるときは、リポジトリで \`/product-design:update\` を実行する（決まりを変え、ここにも写し直す）。
- 版 ${config.ds_version}、土台 ${config.base === 'hig' ? 'Apple HIG' : 'shadcn/ui ＋ Tailwind'}。
`
}

// 部品の仕様を、Design System の部品の README にする（最初の文が要約になるよう、目的を見出しのすぐ下に置く）。
function componentReadme(spec, file) {
  const { body } = parseFrontMatter(spec)
  const title = /^# (.+)$/m.exec(body)?.[1] ?? ''
  const purpose = /^## 目的\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body)?.[1].trim() ?? ''
  const rest = body.replace(/^# .+$/m, '').replace(/^## 目的\s*\n[\s\S]*?(?=^## |(?![\s\S]))/m, '').trim()
  return `# ${title}\n\n${purpose}\n\n${rest}\n\n---\n\n仕様の正はリポジトリの \`${file}\`。\n`
}

// 見本のページの <main> を、Design System の部品の preview.html にする（1 行目は Design System のカードの印）。
function componentPreview(page) {
  const m = /<main class="ds-page" data-group="([^"]+)" data-height="(\d+)">([\s\S]*?)<\/main>/.exec(page)
  if (!m) return null
  return `<!-- @dsCard group="${m[1]}" height=${m[2]} -->\n<main class="ds-page">${m[3].replace(/\s+$/, '')}\n</main>\n`
}

// Design System の tokens.css。編集できないページは自分で作らないので、写す側が作る（1 行目は型の決まりの印）。
function designSystemCss(title, root, ds) {
  const families = Object.entries(ds.type.families).map(([k, v]) => `  --font-${k}: ${v};`)
  const styles = ds.type.groups.flatMap((g) => g.styles).map((s) => `.${s.name} { font: var(--font-${s.name}); letter-spacing: var(--letter-spacing-${s.name}); }`)
  return [`/* ${title} — generated from tokens.json */`, generateCss(root), ':root {', ...families, '}', '', ...styles, ''].join('\n')
}

// Design System に写すファイルを <dir>/project/ に並べる。Artifact の publish に root: <dir>、file_path: 索引、files: 残りを渡す。
// index に今の索引（読んで保存したもの）を渡すと、そのキーと名前を保って、編集を止めた印と lastChange だけを書き換える。
export function artifactStage(repo, dir, { title, index, by = 'Claude', now = new Date().toISOString() } = {}) {
  const config = loadConfig(repo)
  const code = config.outputs?.html?.code
  if (!code) throw new Error(`${CONFIG_PATH} に outputs.html がありません`)
  const root = JSON.parse(readFileSync(join(repo, config.tokens), 'utf8'))
  const { errors } = validateTokens(root, config.base)
  if (errors.length) throw new Error(`${config.tokens} に誤りがあるので写せません（${errors.length} 件。最初: ${errors[0]}）`)
  const readme = readFileSync(join(repo, DS_DIR, 'README.md'), 'utf8')
  const name = title ?? /^# (.+)$/m.exec(readme)?.[1] ?? basename(repo)

  const out = join(dir, 'project')
  rmSync(out, { recursive: true, force: true })
  const files = {}
  const put = (rel, text) => {
    mkdirSync(dirname(join(out, rel)), { recursive: true })
    writeFileSync(join(out, rel), text)
    files[`project/${rel}`] = `project/${rel}`
  }
  const ds = toDesignSystemTokens(root, { title: name, ...config })
  put('tokens.json', JSON.stringify(ds, null, 2) + '\n')
  put('tokens.css', designSystemCss(name, root, ds))
  put('README.md', readme.trimEnd() + claudeDesignRules(config))
  put('product-principles.md', readFileSync(join(repo, config.product_principles), 'utf8'))
  for (const doc of config.docs ?? []) if (basename(doc) !== 'README.md' && existsSync(join(repo, doc))) put(basename(doc), readFileSync(join(repo, doc), 'utf8'))

  const htmlDir = join(repo, code)
  const sheets = [join(htmlDir, 'base.css'), ...readdirSync(join(htmlDir, 'components')).filter((n) => n.endsWith('.css')).sort().map((n) => join(htmlDir, 'components', n))]
  put('components/bundle.css', sheets.filter((f) => existsSync(f)).map((f) => readFileSync(f, 'utf8').trimEnd()).join('\n\n') + '\n')
  const specs = config.components ?? `${DS_DIR}/components`
  for (const f of readdirSync(join(repo, specs)).filter((n) => n.endsWith('.md') && n !== 'README.md').sort()) {
    const spec = readFileSync(join(repo, specs, f), 'utf8')
    const html = parseFrontMatter(spec).data?.outputs?.html
    const page = typeof html === 'string' ? join(htmlDir, 'components', `${html}.html`) : null
    if (!page || !existsSync(page)) continue
    const preview = componentPreview(readFileSync(page, 'utf8'))
    if (!preview) continue
    put(`components/${pascal(html)}/README.md`, componentReadme(spec, posix(join(specs, f))))
    put(`components/${pascal(html)}/preview.html`, preview)
  }

  const fresh = { v: 3, layout: 'files', createdOnFiles: { v: 1, at: now }, title: name, namespace: pascal(name) || 'DesignSystem', libraries: [], sections: {}, groups: [], assetGroups: {}, blobs: {}, docs: { readme: 'project/README.md', sections: [] } }
  const current = index ? JSON.parse(readFileSync(index, 'utf8')) : fresh
  const indexFile = join(out, 'design-system.json')
  writeFileSync(indexFile, JSON.stringify({ ...current, editing: 'code', lastChange: { by, at: now, via: 'product-design', note: `design-system ${config.ds_version} を写した` } }, null, 2) + '\n')
  return { root: dir, file_path: indexFile, files, hash: artifactHash(repo, config) }
}

// 写し終えた Artifact の url と、写した中身のハッシュを design-system.json に書く。
export function artifactDone(repo, url) {
  if (!/^https:\/\/claude\.ai\//.test(url ?? '')) throw new Error('写した Artifact の url（https://claude.ai/…）を渡してください')
  const config = loadConfig(repo)
  config.artifact = { url, hash: artifactHash(repo, config) }
  writeConfig(repo, config)
  return config.artifact
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

const USAGE = 'node cli.mjs install|stage|trace|tokens|screenshot|artifact-stage|artifact-done|status <repo> …'

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
    case 'artifact-stage':
      if (!rest[0] || rest[0].startsWith('--')) throw new Error('使い方: node cli.mjs artifact-stage <repo> <dir> [--title <名前>] [--index <今の索引>] [--by <名前>]')
      return artifactStage(repo, resolve(rest[0]), { title: option(argv, '--title'), index: option(argv, '--index'), by: option(argv, '--by') })
    case 'artifact-done':
      return artifactDone(repo, rest[0])
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
