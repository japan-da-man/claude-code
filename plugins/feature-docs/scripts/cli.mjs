// スキルから呼ぶ CLI。結果は JSON で出す。
//   node cli.mjs install <repo> [--ci] [--pr-template]   check.mjs を写し、ないものだけ設定とひな形を置く
//   node cli.mjs status <repo>                           段階の一覧に、写した check.mjs が古いかどうかを加えて出す
//   node cli.mjs check <repo>                            整合のチェック（feature-docs/check.mjs --json と同じ）
//   node cli.mjs next-id <repo> req|feature              次の番号
//   node cli.mjs export-help <repo> [--out <dir>] [--force]
//   node cli.mjs template <name>                         テンプレートのパス（requirements / design / feature / tracking / adr）
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_PATH, DEFAULT_CONFIG, exportHelp, loadConfig, nextId, runCheck, status as stages } from './check.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CHECK = join(ROOT, 'scripts', 'check.mjs')
const TEMPLATES = join(ROOT, 'templates')
export const VENDORED = 'feature-docs/check.mjs'
const TEMPLATE_FILES = {
  requirements: 'requirements.md',
  design: 'design.md',
  feature: 'feature.yaml',
  tracking: 'tracking.yaml',
  adr: 'adr.md',
}

const posix = (p) => p.split(sep).join('/')

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((p) => statSync(join(dir, p)).isFile() && !p.endsWith('.DS_Store'))
    .sort()
}

export function install(repo, { ci = false, prTemplate = false } = {}) {
  const copied = []
  const updated = []
  const skipped = []
  const created_dirs = []

  const vendored = join(repo, VENDORED)
  mkdirSync(dirname(vendored), { recursive: true })
  const fresh = readFileSync(CHECK, 'utf8')
  if (!existsSync(vendored)) {
    copyFileSync(CHECK, vendored)
    copied.push(VENDORED)
  } else if (readFileSync(vendored, 'utf8') !== fresh) {
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

  const config = loadConfig(repo)
  const p = config.paths
  // ひな形は既定の場所のものを、設定の場所に置く
  const remap = {
    'docs/product/overview.md': p.product,
    'actors.yaml': p.actors,
    'glossary.yaml': p.glossary,
    'docs/architecture/overview.md': `${p.architecture}/overview.md`,
  }
  const repoTemplates = join(TEMPLATES, 'repo')
  for (const rel of filesUnder(repoTemplates)) {
    const key = posix(rel)
    place(join(repoTemplates, rel), remap[key] ?? key)
  }

  for (const dir of [p.requirements, p.design, p.ui, p.adr, p.tracking, p.features]) {
    const abs = join(repo, dir)
    if (existsSync(abs)) continue
    mkdirSync(abs, { recursive: true })
    writeFileSync(join(abs, '.gitkeep'), '')
    created_dirs.push(dir)
  }

  if (ci) place(join(TEMPLATES, 'ci', 'feature-docs.yml'), '.github/workflows/feature-docs.yml')
  if (prTemplate) place(join(TEMPLATES, 'ci', 'pull_request_template.md'), '.github/pull_request_template.md')

  return { copied, updated, skipped, created_dirs }
}

export function status(repo) {
  const vendored = join(repo, VENDORED)
  const check = !existsSync(vendored) ? 'missing' : readFileSync(vendored, 'utf8') === readFileSync(CHECK, 'utf8') ? 'ok' : 'stale'
  return {
    installed: existsSync(join(repo, CONFIG_PATH)),
    vendored_check: check,
    ...stages(repo),
  }
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
  const option = (name) => {
    const i = args.indexOf(name)
    if (i === -1) return undefined
    const v = args[i + 1]
    args.splice(i, 2)
    return v
  }
  const cmd = args.shift()
  const out = (v) => console.log(JSON.stringify(v, null, 2))
  if (cmd === 'template') return out({ path: templatePath(args[0]) }), 0
  const repo = resolve(args.shift() ?? '.')
  switch (cmd) {
    case 'install': {
      const ci = flag('--ci')
      const prTemplate = flag('--pr-template')
      out(install(repo, { ci, prTemplate }))
      return 0
    }
    case 'status':
      out(status(repo))
      return 0
    case 'check': {
      const result = runCheck(repo)
      out(result)
      return result.ok ? 0 : 1
    }
    case 'next-id':
      out({ id: nextId(repo, args[0]) })
      return 0
    case 'export-help': {
      const o = option('--out')
      const result = exportHelp(repo, { out: o, force: flag('--force') })
      out({ ok: result.ok, out: result.out ? posix(relative(repo, result.out)) || '.' : null, written: result.written.map((f) => posix(relative(repo, f))), skipped: result.skipped, errors: result.check.errors })
      return result.ok ? 0 : 1
    }
    default:
      console.error('使い方: node cli.mjs install|status|check|next-id|export-help <repo> …  /  node cli.mjs template <name>')
      return 2
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    console.error(`feature-docs: ${e.message}`)
    process.exitCode = 2
  }
}
