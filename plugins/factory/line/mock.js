// UI 案の段階: 案ごとの画面をデザインシステムの部品で作り、シミュレーターで撮って人に選んでもらう。
// 案のコードは捨てるための worktree（origin の最新から detached で作る）にだけ書き、撮り終えたら worktree ごと消す。
// 案の画面はカタログのページ（起動引数 -DesignSystemCatalog <ページ>）として出す。カタログの切り替えも、その worktree の中でだけ書き換える。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { DESIGN_SYSTEM_FILE } from './design.js'

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} が失敗しました: ${r.stdout}${r.stderr}`)
  return r.stdout.trim()
}

export function prepareMock({ repo, id, workRoot, outDir }) {
  const file = join(repo, DESIGN_SYSTEM_FILE)
  if (!existsSync(file)) throw new Error(`${file} がありません。UI 案は design-system の部品で作るので、先に /design-system:init を実行してください`)
  const ios = JSON.parse(readFileSync(file, 'utf8')).ios ?? {}
  if (!ios.code || !ios.sources?.length) throw new Error(`${file} に ios.code と ios.sources がありません`)
  const dir = join(workRoot, `${id}-mock`)
  if (existsSync(dir)) cleanMock({ repo, dir })
  mkdirSync(workRoot, { recursive: true })
  spawnSync('git', ['fetch', '-q', 'origin'], { cwd: repo })
  const base = spawnSync('git', ['rev-parse', '--verify', '-q', 'origin/HEAD'], { cwd: repo }).status === 0 ? 'origin/HEAD' : 'HEAD'
  git(repo, 'worktree', 'add', '-q', '--detach', dir, base)
  mkdirSync(outDir, { recursive: true })
  return {
    dir,
    mocks: join(dir, ios.sources[0], 'FactoryMocks'),
    catalog: join(dir, ios.code, 'Catalog', 'DesignSystemCatalog.swift'),
    out: outDir,
  }
}

export function cleanMock({ repo, dir }) {
  spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: repo })
}

const simctl = (...args) => ({ cmd: 'xcrun', args: ['simctl', ...args] })

// 撮る手順を組み立てる（実行は runShotPlan）。案は見比べるだけなのでライトの 1 枚ずつ。
export function mockShotPlan({ config, dir, udid, derived, out, pages, xcodegen }) {
  const { project, scheme, bundle_id: bundle } = config.ios
  const steps = []
  if (xcodegen) steps.push({ cmd: 'xcodegen', args: ['generate'] })
  steps.push({ cmd: 'xcodebuild', args: ['build', '-quiet', '-project', project, '-scheme', scheme, '-destination', `platform=iOS Simulator,id=${udid}`, '-derivedDataPath', derived] })
  steps.push({ ...simctl('boot', udid), mayFail: true }, simctl('bootstatus', udid, '-b'))
  steps.push({ ...simctl('uninstall', udid, bundle), mayFail: true }, simctl('install', udid, '{app}'))
  steps.push(simctl('ui', udid, 'appearance', 'light'))
  steps.push(simctl('status_bar', udid, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100'))
  // 入れ直した直後の最初の起動は遅いので、撮る前に一度起動しておく
  steps.push(simctl('launch', udid, bundle), { sleep: 3000 }, { ...simctl('terminate', udid, bundle), mayFail: true })
  for (const page of [...new Set(pages)]) {
    steps.push({ ...simctl('terminate', udid, bundle), mayFail: true })
    steps.push(simctl('launch', udid, bundle, '-DesignSystemCatalog', page))
    steps.push({ sleep: 2000 })
    // 起動直後は画面が出てくる途中のことがあるので、落ち着くまで撮り直す（shootSettled）
    steps.push({ shot: join(out, `${page}.png`), udid, settle: true })
  }
  steps.push({ ...simctl('terminate', udid, bundle), mayFail: true }, { ...simctl('status_bar', udid, 'clear'), mayFail: true })
  return steps
}

const same = (a, b) => (Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : a === b)

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

// PNG の行（フィルタの種類の 1 バイトつき）を取り出す。読めない形なら null。
function pngRows(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null
  let width = 0
  let height = 0
  let bits = 0
  let color = 0
  const idat = []
  for (let at = 8; at + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(at)
    const type = buf.toString('ascii', at + 4, at + 8)
    const data = buf.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') [width, height, bits, color] = [data.readUInt32BE(0), data.readUInt32BE(4), data[8], data[9]]
    if (type === 'IDAT') idat.push(data)
    at += 12 + len
  }
  if (!width || !CHANNELS[color]) return null
  try {
    const raw = inflateSync(Buffer.concat(idat))
    const rowLen = 1 + Math.ceil((width * CHANNELS[color] * bits) / 8)
    return Array.from({ length: height }, (_, r) => raw.subarray(r * rowLen, (r + 1) * rowLen))
  } catch {
    return null
  }
}

// 状態バーより下（上の 10% と下の 5% を除く）が、ほぼ同じ行ばかりなら、まだ何も描かれていない画面とみなす。
export function looksBlank(buf) {
  const rows = pngRows(buf)
  if (!rows) return false
  const body = rows.slice(Math.floor(rows.length * 0.1), Math.floor(rows.length * 0.95))
  return new Set(body.map((r) => r.toString('base64'))).size <= 3
}

// 1 秒あけて撮り、直前と同じ画像になったら落ち着いたとみなす。最大 10 枚まで撮る。
export function shootSettled(step, { capture, read, sleep }, tries = 10) {
  let prev = null
  for (let i = 0; i < tries; i++) {
    if (i > 0) sleep(1000)
    capture(step.shot)
    const cur = read(step.shot)
    // 真っ白な画面が続いても、それは落ち着いたのではなく、まだ描かれていないだけ
    if (prev !== null && same(prev, cur) && !looksBlank(cur)) return { settled: true }
    prev = cur
  }
  return { settled: false }
}

export function runShotPlan(steps, { cwd, findApp }) {
  let app = null
  const shots = []
  for (const step of steps) {
    if (step.sleep) {
      spawnSync('sleep', [String(step.sleep / 1000)])
      continue
    }
    if (step.shot) {
      const capture = (path) => {
        const r = spawnSync('xcrun', ['simctl', 'io', step.udid, 'screenshot', path], { encoding: 'utf8' })
        if (r.status !== 0) throw new Error(`スクリーンショットを撮れませんでした: ${r.stderr}`)
      }
      const { settled } = shootSettled(step, { capture, read: (p) => readFileSync(p), sleep: (ms) => spawnSync('sleep', [String(ms / 1000)]) })
      shots.push(settled ? step.shot : `${step.shot}（画面が落ち着かないまま撮った）`)
      continue
    }
    if (step.args.includes('{app}')) app ??= findApp()
    const r = spawnSync(step.cmd, step.args.map((a) => (a === '{app}' ? app : a)), { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0 && !step.mayFail) throw new Error(`${step.cmd} ${step.args.join(' ')} が失敗しました:\n${(r.stdout + r.stderr).slice(-4000)}`)
  }
  return shots
}
