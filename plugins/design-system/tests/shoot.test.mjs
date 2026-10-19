import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { changedRows, factoryLineRunning, findApp, looksBlank, parseShootArgs, resolveDevice, runPlan, screenshotPlan } from '../scripts/shoot.mjs'

// 幅 4・高さ rows.length の RGB の PNG。rows は各行の色（0〜255 の灰色）
function png(rows) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(4, 0)
  ihdr.writeUInt32BE(rows.length, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.concat(rows.map((v) => Buffer.from([0, ...Array(12).fill(v)])))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const simctl = {
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [{ name: 'iPhone 17', udid: 'OLD', isAvailable: true }],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ name: 'iPhone 17', udid: 'NEW', isAvailable: true }],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-10': [{ name: 'iPhone 17', udid: 'BROKEN', isAvailable: false }],
  },
}

test('the newest available runtime wins when names repeat', () => {
  assert.equal(resolveDevice(simctl, 'iPhone 17'), 'NEW')
  assert.throws(() => resolveDevice(simctl, 'iPhone 99'), /iPhone 99/)
})

const config = { ios: { project: 'App.xcodeproj', scheme: 'App', bundle_id: 'com.example.App', catalog_pages: ['colors', 'buttons'] } }

function plan(extra = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'ds-ios-'))
  return { repo, steps: screenshotPlan({ config, repo, udid: 'U', derived: '/d', out: '/o', pages: ['colors', 'buttons'], appearances: ['light', 'dark'], ...extra }) }
}

const line = (s) => (s.sleep ? `sleep ${s.sleep}` : s.shot ? `shot ${s.shot}` : [s.cmd, ...s.args].join(' '))

test('the plan builds, reinstalls, then shoots every page in every appearance', () => {
  const { steps } = plan()
  const lines = steps.map(line)
  assert.equal(lines[0], 'xcodebuild build -quiet -project App.xcodeproj -scheme App -destination platform=iOS Simulator,id=U -derivedDataPath /d')
  assert.ok(lines.includes('xcrun simctl boot U'))
  assert.ok(lines.includes('xcrun simctl install U {app}'))
  assert.ok(lines.some((l) => l.startsWith('xcrun simctl status_bar U override --time 9:41')))
  assert.deepEqual(
    lines.filter((l) => l.startsWith('shot ')),
    ['shot /o/colors-light.png', 'shot /o/buttons-light.png', 'shot /o/colors-dark.png', 'shot /o/buttons-dark.png'],
  )
  // 入れ直した直後の最初の起動は遅いので、撮る前に一度起動しておく
  const warm = lines.indexOf('xcrun simctl launch U com.example.App')
  assert.ok(warm > lines.indexOf('xcrun simctl install U {app}') && warm < lines.indexOf('shot /o/colors-light.png'))
  assert.ok(lines.includes('xcrun simctl launch U com.example.App -DesignSystemCatalog buttons'))
  assert.equal(lines.at(-1), 'xcrun simctl ui U appearance light')
})

test('a project.yml means xcodegen runs first', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ds-ios-'))
  writeFileSync(join(repo, 'project.yml'), 'name: App\n')
  const steps = screenshotPlan({ config, repo, udid: 'U', derived: '/d', out: '/o', pages: [], appearances: ['light'] })
  assert.equal(line(steps[0]), 'xcodegen generate')
})

test('the app itself can be shot as well, launched without the catalog', () => {
  const { steps } = plan({ pages: [], appearances: ['dark'], app: true })
  const lines = steps.map(line)
  assert.ok(lines.includes('xcrun simctl launch U com.example.App'))
  assert.ok(lines.includes('shot /o/app-dark.png'))
})

test('running a plan stops at the first failing command but not at ones allowed to fail', () => {
  const ran = []
  const exec = (cmd, args) => {
    ran.push([cmd, ...args].join(' '))
    return { ok: !args.includes('install'), out: 'boom' }
  }
  const steps = [
    { cmd: 'xcrun', args: ['simctl', 'terminate', 'U', 'x'], mayFail: true },
    { cmd: 'xcrun', args: ['simctl', 'install', 'U', '{app}'] },
    { cmd: 'xcrun', args: ['simctl', 'io', 'U', 'screenshot', '/o/a.png'] },
  ]
  assert.throws(() => runPlan(steps, { exec, app: '/d/App.app', sleep: () => {} }), /install U \/d\/App\.app[\s\S]*boom/)
  assert.equal(ran.length, 2)
})

test('the app is looked up after the build, so {app} is filled in when it is needed', () => {
  const derived = mkdtempSync(join(tmpdir(), 'ds-derived-'))
  const products = join(derived, 'Build', 'Products', 'Debug-iphonesimulator')
  mkdirSync(join(products, 'App.app'), { recursive: true })
  assert.equal(findApp(derived), join(products, 'App.app'))
  const ran = []
  runPlan([{ cmd: 'xcrun', args: ['simctl', 'install', 'U', '{app}'] }, { sleep: 5 }], { exec: (c, a) => (ran.push(a.join(' ')), { ok: true }), app: () => findApp(derived), sleep: () => {} })
  assert.deepEqual(ran, [`simctl install U ${join(products, 'App.app')}`])
})

test('a shot is retaken until the screen stops changing', () => {
  const frames = ['blank', 'half', 'page', 'page', 'page', 'other']
  let n = 0
  const exec = (cmd, args) => ((last = frames[n++]), { ok: true })
  let last
  const slept = []
  const r = runPlan([{ shot: '/o/a.png', udid: 'U' }], { exec, read: () => last, sleep: (ms) => slept.push(ms), app: '/x' })
  assert.equal(n, 5)
  assert.deepEqual(r.unsettled, [])
  assert.ok(slept.reduce((a, b) => a + b, 0) >= 2000)
})

test('a screen that never settles is kept but reported', () => {
  let n = 0
  const exec = () => ({ ok: true })
  const r = runPlan([{ shot: '/o/a.png', udid: 'U' }], { exec, read: () => String(n++), sleep: () => {}, app: '/x' })
  assert.deepEqual(r.unsettled, ['/o/a.png'])
})

test('changedRows counts the share of pixel rows that differ between two PNGs', () => {
  const base = Array(100).fill(255)
  assert.equal(changedRows(png(base), png(base)), 0)
  const spinner = [...base]
  spinner[50] = 10
  assert.equal(changedRows(png(base), png(spinner)), 0.01)
  assert.equal(changedRows(png(base), png(Array(100).fill(0))), 1)
  assert.equal(changedRows(png(base), png(Array(50).fill(255))), 1)
})

test('a spinner that keeps moving still counts as settled', () => {
  // 中身の描かれた画面（行ごとに違う色）の上で、読み込み中の印（40 行目）だけが動き続ける
  const base = Array.from({ length: 100 }, (_, r) => (r * 7) % 256)
  const frames = [png(Array(100).fill(0)), ...[1, 2, 3].map((i) => png(base.map((v, r) => (r === 40 ? i * 50 : v))))]
  let n = 0
  let last
  const r = runPlan([{ shot: '/o/a.png', udid: 'U' }], { exec: () => ((last = frames[n++]), { ok: true }), read: () => last, sleep: () => {}, app: '/x' })
  assert.equal(n, 4)
  assert.deepEqual(r.unsettled, [])
})

test('a running factory line holds the simulator', () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-factory-'))
  assert.equal(factoryLineRunning(home), false)
  writeFileSync(join(home, 'line.lock'), JSON.stringify({ pid: process.pid }))
  assert.equal(factoryLineRunning(home), true)
  writeFileSync(join(home, 'line.lock'), JSON.stringify({ pid: 999999 }))
  assert.equal(factoryLineRunning(home), false)
})

test('a blank screen that stays blank is not a settled screen', () => {
  // 上 10% は状態バー（黒）、その下が真っ白なまま 3 枚続いても、落ち着いたとはみなさない
  const blank = png([...Array(10).fill(0), ...Array(90).fill(255)])
  const page = png([...Array(10).fill(0), ...Array.from({ length: 90 }, (_, i) => (i * 7) % 256)])
  const frames = [blank, blank, blank, blank, page, page, page]
  let n = 0
  let last
  const exec = () => ((last = frames[Math.min(n++, frames.length - 1)]), { ok: true })
  const r = runPlan([{ shot: '/o/a.png', udid: 'U' }], { exec, read: () => last, sleep: () => {}, app: '/x' })
  assert.deepEqual(r.unsettled, [])
  assert.equal(n, 7)
})

test('looksBlank tells an empty screen from a drawn one', () => {
  assert.equal(looksBlank(png([...Array(10).fill(0), ...Array(90).fill(255)])), true)
  assert.equal(looksBlank(png([...Array(10).fill(0), ...Array.from({ length: 90 }, (_, i) => (i * 7) % 256)])), false)
  assert.equal(looksBlank(Buffer.from('not a png')), false)
})

test('the vendored shoot.mjs parses its own command line', () => {
  assert.deepEqual(parseShootArgs(['--pages', 'a,b', '--appearance', 'light', '--out', 'o']), { pages: ['a', 'b'], appearances: ['light'], app: false, out: 'o' })
  assert.deepEqual(parseShootArgs(['--app']), { pages: undefined, appearances: ['light', 'dark'], app: true, out: undefined })
})

test('a booted simulator with the name wins over a newer runtime, so only one runs', () => {
  const list = {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [{ name: 'iPhone 17', udid: 'OLD-BOOTED', isAvailable: true, state: 'Booted' }],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [{ name: 'iPhone 17', udid: 'NEW', isAvailable: true, state: 'Shutdown' }],
    },
  }
  assert.equal(resolveDevice(list, 'iPhone 17'), 'OLD-BOOTED')
})
