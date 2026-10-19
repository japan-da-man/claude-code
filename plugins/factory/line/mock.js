// UI 案の段階: 案ごとの画面をデザインシステムの部品で作り、シミュレーターで撮って人に選んでもらう。
// 案のコードは捨てるための worktree（origin の最新から detached で作る）にだけ書き、撮り終えたら worktree ごと消す。
// 案の画面はカタログのページ（起動引数 -DesignSystemCatalog <ページ>）として出す。カタログの切り替えも、その worktree の中でだけ書き換える。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  for (const page of pages) {
    steps.push({ ...simctl('terminate', udid, bundle), mayFail: true })
    steps.push(simctl('launch', udid, bundle, '-DesignSystemCatalog', page))
    steps.push({ sleep: 2500 })
    steps.push({ shot: join(out, `${page}.png`), udid })
  }
  steps.push({ ...simctl('terminate', udid, bundle), mayFail: true }, { ...simctl('status_bar', udid, 'clear'), mayFail: true })
  return steps
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
      const r = spawnSync('xcrun', ['simctl', 'io', step.udid, 'screenshot', step.shot], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`スクリーンショットを撮れませんでした: ${r.stderr}`)
      shots.push(step.shot)
      continue
    }
    if (step.args.includes('{app}')) app ??= findApp()
    const r = spawnSync(step.cmd, step.args.map((a) => (a === '{app}' ? app : a)), { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0 && !step.mayFail) throw new Error(`${step.cmd} ${step.args.join(' ')} が失敗しました:\n${(r.stdout + r.stderr).slice(-4000)}`)
  }
  return shots
}
