// iOS の検証アダプター: ビルド、全テスト、アプリの入れ直し、検証役による 1 シナリオの実行。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '../prompts.js'

const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`

function runtimeVersion(key) {
  const m = /iOS-(\d+)-(\d+)/.exec(key)
  return m ? Number(m[1]) * 1000 + Number(m[2]) : -1
}

// 同じ名前のシミュレーターが複数の iOS にあるときは、いちばん新しい iOS のものを使う。
export function resolveDevice(simctlJson, name) {
  const found = Object.entries(simctlJson.devices)
    .filter(([key]) => key.includes('iOS'))
    .sort(([a], [b]) => runtimeVersion(b) - runtimeVersion(a))
    .flatMap(([, list]) => list)
    .find((d) => d.name === name && d.isAvailable)
  if (!found) throw new Error(`シミュレーター "${name}" が見つかりません（xcrun simctl list devices available で確かめてください）`)
  return found.udid
}

export function listDevices() {
  return JSON.parse(sh('xcrun simctl list devices available -j').out)
}

// derived: ビルド結果の置き場所。リポジトリの外に置き、実装役がコミットしてしまわないようにする。
export function commands({ config, repo, udid, derived }) {
  const { project, scheme, prebuild } = config.ios
  const base = `-project ${q(project)} -scheme ${q(scheme)} -destination ${q(`platform=iOS Simulator,id=${udid}`)} -derivedDataPath ${q(derived)}`
  return {
    prebuild: prebuild ?? (existsSync(join(repo, 'project.yml')) ? 'xcodegen generate' : null),
    build: `xcodebuild build ${base}`,
    test: `xcodebuild test ${base}`,
  }
}

export function findApp(derived) {
  const products = join(derived, 'Build', 'Products', 'Debug-iphonesimulator')
  const app = existsSync(products) && readdirSync(products).find((n) => n.endsWith('.app'))
  if (!app) throw new Error(`${products} にビルドした .app がありません`)
  return join(products, app)
}

function sh(cmd, cwd) {
  const r = spawnSync('/bin/sh', ['-c', cmd], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') }
}

// ビルドと全テスト。失敗したときは、ログの最後だけを返す。
export function buildAndTest(cmds, cwd) {
  for (const cmd of [cmds.prebuild, cmds.build, cmds.test].filter(Boolean)) {
    const r = sh(cmd, cwd)
    if (!r.ok) return { ok: false, command: cmd, log: r.out.slice(-8000) }
  }
  return { ok: true }
}

// 前の実行の状態を持ち越さないよう、毎回アプリを消してから入れ直す。
export function resetApp({ udid, bundleId, app }) {
  sh(`xcrun simctl boot ${q(udid)}`)
  sh(`xcrun simctl bootstatus ${q(udid)} -b`)
  sh(`xcrun simctl uninstall ${q(udid)} ${q(bundleId)}`)
  const r = sh(`xcrun simctl install ${q(udid)} ${q(app)}`)
  if (!r.ok) throw new Error(`アプリを入れられませんでした: ${r.out.slice(-2000)}`)
}

export function shutdown(udid) {
  sh(`xcrun simctl shutdown ${q(udid)}`)
}

// 検証役は記録先（out）を作業ディレクトリにして動き、シナリオのフォルダだけを追加で読める。
export function verifyRole({ config, udid, scenario, scenarioDir, out, session }) {
  return {
    cwd: out,
    model: config.models.verify,
    allowedTools: ['Read', 'Write', 'Bash(agent-device *)'],
    addDirs: [scenarioDir],
    prompt: render('verify', { scenario, out, bundle_id: config.ios.bundle_id, udid, session }),
  }
}
