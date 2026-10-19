// カタログ画面のスクリーンショットを、シミュレーターで撮る。
// 手順は screenshotPlan が組み立て（テストできるように、実行はしない）、runPlan が順に実行する。
// check.mjs と一緒にアプリの design-system/ に写し、そこからコマンドとしても使う（factory の UI 案の撮影もこれを使う）:
//   node design-system/shoot.mjs [--pages a,b] [--appearance light,dark] [--app] [--out <dir>]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import { CONFIG_PATH, loadConfig } from './check.mjs'

function runtimeVersion(key) {
  const m = /iOS-(\d+)-(\d+)/.exec(key)
  return m ? Number(m[1]) * 1000 + Number(m[2]) : -1
}

// 同じ名前のシミュレーターが複数の iOS にあるときは、起動中のものを、なければいちばん新しい iOS のものを使う（factory と同じ）。
export function resolveDevice(simctlJson, name) {
  const candidates = Object.entries(simctlJson.devices)
    .filter(([key]) => key.includes('iOS'))
    .sort(([a], [b]) => runtimeVersion(b) - runtimeVersion(a))
    .flatMap(([, list]) => list)
    .filter((d) => d.name === name && d.isAvailable)
  // すでに起動しているものがあれば、それを使う（デスクトップアプリのシミュレーターのペインなどが起動していると、2 台目を起動してメモリを圧迫するため）
  const found = candidates.find((d) => d.state === 'Booted') ?? candidates[0]
  if (!found) throw new Error(`シミュレーター "${name}" が見つかりません（xcrun simctl list devices available で確かめてください）`)
  return found.udid
}

export function findApp(derived) {
  const products = join(derived, 'Build', 'Products', 'Debug-iphonesimulator')
  const app = existsSync(products) && readdirSync(products).find((n) => n.endsWith('.app'))
  if (!app) throw new Error(`${products} にビルドした .app がありません`)
  return join(products, app)
}

// この Mac ではシミュレーターを1台ずつしか使えないので、factory のラインが動いている間は撮らない。
export function factoryLineRunning(home) {
  try {
    const { pid } = JSON.parse(readFileSync(join(home, 'line.lock'), 'utf8'))
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

const simctl = (...args) => ({ cmd: 'xcrun', args: ['simctl', ...args] })

// pages: カタログのページ。app: カタログでない、ふつうの起動の画面も撮る。
// 画像は <out>/<ページ>-<light|dark>.png（ふつうの起動は app-<light|dark>.png）。
export function screenshotPlan({ config, repo, udid, derived, out, pages, appearances, app = false }) {
  const { project, scheme, bundle_id: bundle } = config.ios
  const steps = []
  if (existsSync(join(repo, 'project.yml'))) steps.push({ cmd: 'xcodegen', args: ['generate'] })
  steps.push({ cmd: 'xcodebuild', args: ['build', '-quiet', '-project', project, '-scheme', scheme, '-destination', `platform=iOS Simulator,id=${udid}`, '-derivedDataPath', derived] })
  steps.push({ ...simctl('boot', udid), mayFail: true }, simctl('bootstatus', udid, '-b'))
  steps.push({ ...simctl('uninstall', udid, bundle), mayFail: true }, simctl('install', udid, '{app}'))
  steps.push(simctl('status_bar', udid, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100', '--wifiBars', '3', '--cellularBars', '4'))
  // 入れ直した直後の最初の起動は遅いので、撮る前に一度起動しておく
  steps.push(simctl('launch', udid, bundle), { sleep: 3000 }, { ...simctl('terminate', udid, bundle), mayFail: true })
  const shots = [...pages.map((p) => ({ name: p, args: ['-DesignSystemCatalog', p] })), ...(app ? [{ name: 'app', args: [] }] : [])]
  for (const appearance of appearances) {
    steps.push(simctl('ui', udid, 'appearance', appearance))
    for (const shot of shots) {
      steps.push({ ...simctl('terminate', udid, bundle), mayFail: true })
      steps.push(simctl('launch', udid, bundle, ...shot.args))
      steps.push({ shot: join(out, `${shot.name}-${appearance}.png`), udid })
    }
  }
  steps.push({ ...simctl('terminate', udid, bundle), mayFail: true })
  steps.push({ ...simctl('status_bar', udid, 'clear'), mayFail: true })
  steps.push(simctl('ui', udid, 'appearance', 'light'))
  return steps
}

export function exec(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error) : '') }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const SHOT = { interval: 1000, same: 3, tries: 15, rows: 0.05 }

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

// PNG を、行ごとのデータ（フィルターの 1 バイトつき）に分ける。読めない形なら null。
function pngRows(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null
  let width, height, bits, color, interlace
  const idat = []
  for (let at = 8; at + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(at)
    const type = buf.toString('ascii', at + 4, at + 8)
    const data = buf.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') [width, height, bits, color, interlace] = [data.readUInt32BE(0), data.readUInt32BE(4), data[8], data[9], data[12]]
    if (type === 'IDAT') idat.push(data)
    at += 12 + len
  }
  if (!width || interlace || !CHANNELS[color]) return null
  const raw = inflateSync(Buffer.concat(idat))
  const rowLen = 1 + Math.ceil((width * CHANNELS[color] * bits) / 8)
  return { width, rows: Array.from({ length: height }, (_, r) => raw.subarray(r * rowLen, (r + 1) * rowLen)) }
}

// 2 枚の PNG で、違う行の割合（0〜1）。大きさが違う・読めないときは、まったく同じでなければ 1。
export function changedRows(a, b) {
  const pa = pngRows(a)
  const pb = pngRows(b)
  if (!pa || !pb || pa.width !== pb.width || pa.rows.length !== pb.rows.length) return Buffer.isBuffer(a) && a.equals(b) ? 0 : 1
  return pa.rows.filter((row, i) => !row.equals(pb.rows[i])).length / pa.rows.length
}

// 状態バーより下（上の 10% と下の 5% を除く）が、ほぼ同じ行ばかりなら、まだ何も描かれていない画面とみなす。
export function looksBlank(buf) {
  const p = pngRows(buf)
  if (!p) return false
  const body = p.rows.slice(Math.floor(p.rows.length * 0.1), Math.floor(p.rows.length * 0.95))
  return new Set(body.map((r) => r.toString('base64'))).size <= 3
}

// 回り続ける読み込み中の印などの小さな動きは、落ち着いたとみなす。
// 真っ白な画面が続いても、それは落ち着いたのではなく、まだ描かれていないだけ。
const settled = (a, b) => (Buffer.isBuffer(a) ? !looksBlank(b) && changedRows(a, b) <= SHOT.rows : a === b)

// 起動の途中（真っ白な画面や、表示のアニメーションの途中）を撮らないよう、同じ画面が続けて撮れるまで撮り直す。
function settledShot(step, { run, read, sleep }) {
  const frames = []
  for (let i = 0; i < SHOT.tries; i++) {
    sleep(SHOT.interval)
    const args = ['simctl', 'io', step.udid, 'screenshot', step.shot]
    const r = run('xcrun', args)
    if (!r.ok) throw new Error(`失敗しました: xcrun ${args.join(' ')}\n${(r.out || '').slice(-4000)}`)
    frames.push(read(step.shot))
    const last = frames.slice(-SHOT.same)
    if (last.length === SHOT.same && last.every((f, i) => i === 0 || settled(last[i - 1], f))) return true
  }
  return false
}

// app: ビルドした .app のパス（ビルドのあとで探せるよう、関数でもよい）。{app} に入る。
// 戻り値の unsettled は、最後まで画面が落ち着かなかったスクリーンショット。
export function runPlan(steps, { exec: run = exec, cwd, app, sleep = sleepSync, read = (p) => readFileSync(p) }) {
  let appPath = typeof app === 'string' ? app : null
  const unsettled = []
  for (const step of steps) {
    if (step.sleep) {
      sleep(step.sleep)
      continue
    }
    if (step.shot) {
      if (!settledShot(step, { run: (c, a) => run(c, a, cwd), read, sleep })) unsettled.push(step.shot)
      continue
    }
    const args = step.args.map((a) => {
      if (a !== '{app}') return a
      appPath ??= app()
      return appPath
    })
    const r = run(step.cmd, args, cwd)
    if (!r.ok && !step.mayFail) throw new Error(`失敗しました: ${[step.cmd, ...args].join(' ')}\n${(r.out || '').slice(-4000)}`)
  }
  return { unsettled }
}

// この Mac ではシミュレーターを 1 台ずつしか使えないので、factory のラインが動いている間は撮らない。
export function shoot(repo, { pages, appearances = ['light', 'dark'], app = false, out } = {}) {
  const config = loadConfig(repo)
  const factoryHome = process.env.FACTORY_HOME || join(homedir(), '.factory')
  if (factoryLineRunning(factoryHome)) throw new Error('factory のラインが動いていて、シミュレーターを使っています。ラインが終わってから撮ってください（/factory:status）')
  const list = JSON.parse(exec('xcrun', ['simctl', 'list', 'devices', 'available', '-j']).out)
  const udid = resolveDevice(list, config.ios.device ?? 'iPhone 17')
  const key = createHash('sha256').update(resolve(repo)).digest('hex').slice(0, 8)
  const derived = join(homedir(), 'Library', 'Caches', 'design-system', `${basename(resolve(repo))}-${key}`, 'DerivedData')
  const outDir = out ? resolve(out) : join(repo, dirname(CONFIG_PATH), 'screenshots')
  mkdirSync(outDir, { recursive: true })
  const steps = screenshotPlan({ config, repo, udid, derived, out: outDir, pages: pages ?? config.ios.catalog_pages ?? [], appearances, app })
  const { unsettled } = runPlan(steps, { cwd: repo, app: () => findApp(derived) })
  return { device: udid, images: steps.filter((s) => s.shot).map((s) => s.shot), unsettled }
}

function option(args, name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

export function parseShootArgs(argv) {
  return {
    pages: option(argv, '--pages')?.split(',').filter(Boolean),
    appearances: option(argv, '--appearance')?.split(',').filter(Boolean) ?? ['light', 'dark'],
    app: argv.includes('--app'),
    out: option(argv, '--out'),
  }
}

// アプリに写した design-system/shoot.mjs をコマンドとして実行したとき。リポジトリは design-system/ の 1 つ上。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    console.log(JSON.stringify(shoot(repo, parseShootArgs(process.argv.slice(2))), null, 2))
  } catch (e) {
    console.error(e.message)
    process.exitCode = 1
  }
}
