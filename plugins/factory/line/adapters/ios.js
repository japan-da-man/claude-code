// iOS の検証アダプター: 環境の事前確認、ビルド、全テスト、アプリの入れ直し、シナリオの XCUITest、検証役による 1 シナリオの実行。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '../prompts.js'
import { seedLaunchArgs } from '../seed.js'

const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`

function runtimeVersion(key) {
  const m = /iOS-(\d+)-(\d+)/.exec(key)
  return m ? Number(m[1]) * 1000 + Number(m[2]) : -1
}

// 同じ名前のシミュレーターが複数の iOS にあるときは、起動中のものを、なければいちばん新しい iOS のものを使う。
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

export function listDevices() {
  return JSON.parse(sh('xcrun simctl list devices available -j').out)
}

// derived: ビルド結果の置き場所。リポジトリの外に置き、実装役がコミットしてしまわないようにする。
// buildForTesting と uiTest は検証用のビルド（コミットした SHA のきれいなチェックアウト）で使う。
export function commands({ config, repo, udid, derived }) {
  const { project, scheme, prebuild, ui_tests } = config.ios
  const base = `-project ${q(project)} -scheme ${q(scheme)} -destination ${q(`platform=iOS Simulator,id=${udid}`)} -derivedDataPath ${q(derived)}`
  return {
    prebuild: prebuild ?? (existsSync(join(repo, 'project.yml')) ? 'xcodegen generate' : null),
    build: `xcodebuild build ${base}`,
    test: `xcodebuild test ${base}`,
    buildForTesting: `xcodebuild build-for-testing ${base}`,
    uiTest: (cls) => `xcodebuild test-without-building ${base} -only-testing:${q(`${ui_tests?.target}/${cls}`)}`,
  }
}

// シナリオの XCUITest のファイルから、テストのクラス名を取り出す（-only-testing に渡す）。
export function uiTestClass(swift) {
  return /\bclass\s+(\w+)\s*:\s*XCTestCase\b/.exec(swift)?.[1] ?? null
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

// 実装役を呼ぶ前に、ラインが使う道具がそろっているかを確かめる。足りないものの一覧を返す（空なら問題なし）。
export function preflight({ config, repo }) {
  const problems = []
  const need = (ok, what) => ok || problems.push(what)
  need(sh('xcodebuild -version').ok, 'xcodebuild が動かない（Xcode を確かめる）')
  need(sh('xcrun simctl list devices available -j').ok, 'xcrun simctl が動かない')
  need(sh('command -v agent-device').ok, 'agent-device がない（npm install -g agent-device）')
  if (!config.ios.prebuild && existsSync(join(repo, 'project.yml'))) need(sh('command -v xcodegen').ok, 'xcodegen がない（brew install xcodegen）')
  need(sh('git ls-remote -q --exit-code origin HEAD', repo).ok, 'origin に繋がらない')
  return problems
}

// 検証用のビルド。シナリオの XCUITest を入れたまま、テストもアプリもまとめて作る。
export function buildForVerify(cmds, cwd) {
  for (const cmd of [cmds.prebuild, cmds.buildForTesting].filter(Boolean)) {
    const r = sh(cmd, cwd)
    if (!r.ok) return { ok: false, command: cmd, log: r.out.slice(-8000) }
  }
  return { ok: true }
}

// 1 シナリオの XCUITest を流す。前提のデータは TEST_RUNNER_FACTORY_SEED で渡す（テスト側で FACTORY_SEED として読める）。
export function runUiTest({ cmds, cls, seed, cwd }) {
  const env = { ...process.env, ...(seed ? { TEST_RUNNER_FACTORY_SEED: Buffer.from(seed, 'utf8').toString('base64') } : {}) }
  const r = spawnSync('/bin/sh', ['-c', cmds.uiTest(cls)], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, log: ((r.stdout || '') + (r.stderr || '')).slice(-4000) }
}

// 前の実行の状態を持ち越さないよう、毎回アプリを消してから入れ直す。
export function resetApp({ udid, bundleId, app }) {
  sh(`xcrun simctl boot ${q(udid)}`)
  sh(`xcrun simctl bootstatus ${q(udid)} -b`)
  sh(`xcrun simctl uninstall ${q(udid)} ${q(bundleId)}`)
  const r = sh(`xcrun simctl install ${q(udid)} ${q(app)}`)
  if (!r.ok) throw new Error(`アプリを入れられませんでした: ${r.out.slice(-2000)}`)
}

// アプリを -FactorySeed つきで一度起動してデータを保存させ、閉じる（アプリ側の口が保存し終えるまで少し待つ）。
export function seedApp({ udid, bundleId, seed }) {
  const r = spawnSync('xcrun', seedLaunchArgs({ udid, bundleId, seed }), { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`前提のデータを仕込めませんでした: ${(r.stdout || '') + (r.stderr || '')}`)
  spawnSync('sleep', ['3'])
  sh(`xcrun simctl terminate ${q(udid)} ${q(bundleId)}`)
}

export function shutdown(udid) {
  sh(`xcrun simctl shutdown ${q(udid)}`)
}

// 検証役が閉じ忘れたセッションは、端末を握ったまま次の実行を止めてしまうので、ラインが必ず閉じる。
export function closeSession(session) {
  sh(`agent-device close --session ${q(session)}`)
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
