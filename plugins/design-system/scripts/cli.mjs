// スキルから呼ぶ CLI。結果は JSON で出す。
//   node cli.mjs install <repo>              check.mjs を写し、ないものだけひな形（tokens.json・文書・SwiftUI の部品とカタログ）を置き、Tokens.swift を作る
//   node cli.mjs tokens <repo>               tokens.json を確かめて Tokens.swift を作り直す
//   node cli.mjs status <repo>               チェックの結果に、古くなった check.mjs を加えて出す
//   node cli.mjs screenshot <repo> [--pages a,b] [--appearance light,dark] [--app] [--out <dir>]
//                                            シミュレーターでカタログ（と、ふつうの起動の画面）を撮る
//   node cli.mjs artifact-stage <repo> <dir> Artifact に写すファイルを <dir>/project/ に並べ、上げるスクリーンショットの一覧を出す
//   node cli.mjs artifact-done <repo> <url>  写した Artifact の url と中身のハッシュを design-system.json に書く
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { CONFIG_PATH, artifactHash, generateSwift, loadConfig, runCheck, validateTokens } from './check.mjs'
import { exec, factoryLineRunning, findApp, resolveDevice, runPlan, screenshotPlan } from './ios.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CHECK = join(ROOT, 'scripts', 'check.mjs')
const TEMPLATES = join(ROOT, 'templates')
const DS_DIR = dirname(CONFIG_PATH)

const posix = (p) => p.split(sep).join('/')

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((p) => statSync(join(dir, p)).isFile() && basename(p) !== '.DS_Store')
    .sort()
}

export function writeTokens(repo) {
  const config = loadConfig(repo)
  const tokens = JSON.parse(readFileSync(join(repo, config.tokens), 'utf8'))
  const errors = validateTokens(tokens)
  if (errors.length) return { written: null, errors }
  const file = posix(join(config.ios.code, 'Tokens.swift'))
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  writeFileSync(join(repo, file), generateSwift(tokens))
  return { written: file, errors: [] }
}

export function install(repo) {
  const config = loadConfig(repo)
  const copied = []
  const skipped = []
  const place = (from, to) => {
    const abs = join(repo, to)
    if (existsSync(abs)) return skipped.push(posix(to))
    mkdirSync(dirname(abs), { recursive: true })
    copyFileSync(from, abs)
    copied.push(posix(to))
  }
  copyFileSync(CHECK, join(repo, DS_DIR, 'check.mjs'))
  place(join(TEMPLATES, 'tokens.json'), config.tokens)
  for (const f of filesUnder(join(TEMPLATES, 'docs'))) place(join(TEMPLATES, 'docs', f), join(DS_DIR, f))
  const ios = join(TEMPLATES, 'ios', 'DesignSystem')
  for (const f of filesUnder(ios)) place(join(ios, f), join(config.ios.code, f))
  const { written, errors } = writeTokens(repo)
  return { check: posix(join(DS_DIR, 'check.mjs')), copied, skipped, tokens: written, errors }
}

export function status(repo) {
  const r = runCheck(repo)
  const vendored = join(repo, DS_DIR, 'check.mjs')
  if (!existsSync(vendored) || readFileSync(vendored, 'utf8') !== readFileSync(CHECK, 'utf8')) {
    r.stale.unshift(`${DS_DIR}/check.mjs がプラグインの版と違います（/design-system:update で写し直す）`)
  }
  return r
}

export function artifactStage(repo, dir) {
  const config = loadConfig(repo)
  const files = {}
  for (const p of [config.tokens, ...(config.docs ?? [])]) {
    const to = join(dir, 'project', basename(p))
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(join(repo, p), to)
    files[`project/${basename(p)}`] = to
  }
  const shots = join(repo, DS_DIR, 'screenshots')
  const screenshots = existsSync(shots)
    ? readdirSync(shots)
        .filter((n) => n.endsWith('.png'))
        .sort()
        .map((name) => ({ name, path: join(shots, name), size: statSync(join(shots, name)).size }))
    : []
  return { files, screenshots, hash: artifactHash(repo, config) }
}

export function artifactDone(repo, url) {
  const file = join(repo, CONFIG_PATH)
  const config = JSON.parse(readFileSync(file, 'utf8'))
  config.artifact = { url, hash: artifactHash(repo, config) }
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
  return config.artifact
}

export function screenshot(repo, { pages, appearances = ['light', 'dark'], app = false, out } = {}) {
  const config = loadConfig(repo)
  const factoryHome = process.env.FACTORY_HOME || join(homedir(), '.factory')
  if (factoryLineRunning(factoryHome)) throw new Error('factory のラインが動いていて、シミュレーターを使っています。ラインが終わってから撮ってください（/factory:status）')
  const list = JSON.parse(exec('xcrun', ['simctl', 'list', 'devices', 'available', '-j']).out)
  const udid = resolveDevice(list, config.ios.device ?? 'iPhone 17')
  const key = createHash('sha256').update(resolve(repo)).digest('hex').slice(0, 8)
  const derived = join(homedir(), 'Library', 'Caches', 'design-system', `${basename(resolve(repo))}-${key}`, 'DerivedData')
  const outDir = out ? resolve(out) : join(repo, DS_DIR, 'screenshots')
  mkdirSync(outDir, { recursive: true })
  const steps = screenshotPlan({ config, repo, udid, derived, out: outDir, pages: pages ?? config.ios.catalog_pages ?? [], appearances, app })
  const { unsettled } = runPlan(steps, { cwd: repo, app: () => findApp(derived) })
  return { device: udid, images: steps.filter((s) => s.shot).map((s) => s.shot), unsettled }
}

function option(args, name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const USAGE = 'node cli.mjs install|tokens|status|screenshot|artifact-stage|artifact-done <repo> …'

export function main(argv) {
  const [command, repoArg, third] = argv
  const repo = repoArg && resolve(repoArg)
  switch (command) {
    case 'install':
      return install(repo)
    case 'tokens':
      return writeTokens(repo)
    case 'status':
      return status(repo)
    case 'screenshot':
      return screenshot(repo, {
        pages: option(argv, '--pages')?.split(',').filter(Boolean),
        appearances: option(argv, '--appearance')?.split(',') ?? ['light', 'dark'],
        app: argv.includes('--app'),
        out: option(argv, '--out'),
      })
    case 'artifact-stage':
      return artifactStage(repo, resolve(third))
    case 'artifact-done':
      return artifactDone(repo, third)
    default:
      throw new Error(`使い方: ${USAGE}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const r = main(process.argv.slice(2))
    console.log(JSON.stringify(r, null, 2))
    if (r?.errors?.length || r?.ok === false) process.exitCode = 1
  } catch (e) {
    console.error(e.message)
    process.exitCode = 1
  }
}
