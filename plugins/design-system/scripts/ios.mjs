// カタログ画面のスクリーンショットを、シミュレーターで撮る。
// 手順は screenshotPlan が組み立て（テストできるように、実行はしない）、runPlan が順に実行する。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'

function runtimeVersion(key) {
  const m = /iOS-(\d+)-(\d+)/.exec(key)
  return m ? Number(m[1]) * 1000 + Number(m[2]) : -1
}

// 同じ名前のシミュレーターが複数の iOS にあるときは、いちばん新しい iOS のものを使う（factory と同じ）。
export function resolveDevice(simctlJson, name) {
  const found = Object.entries(simctlJson.devices)
    .filter(([key]) => key.includes('iOS'))
    .sort(([a], [b]) => runtimeVersion(b) - runtimeVersion(a))
    .flatMap(([, list]) => list)
    .find((d) => d.name === name && d.isAvailable)
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

// 回り続ける読み込み中の印などの小さな動きは、落ち着いたとみなす。
const settled = (a, b) => (Buffer.isBuffer(a) ? changedRows(a, b) <= SHOT.rows : a === b)

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
