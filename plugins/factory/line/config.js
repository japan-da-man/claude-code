// .factory/config.json を読み、既定値と合わせて検証する。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const CONFIG_PATH = join('.factory', 'config.json')

export const DEFAULTS = {
  type: null,
  // ui_tests: シナリオの XCUITest を流す UI テストのターゲット（{ target, dir }）。/factory:init で足す。なければ使わない
  ios: { project: null, scheme: null, bundle_id: null, device: 'iPhone 17', prebuild: null, ui_tests: null },
  autonomy: 5,
  models: { interview: 'opus', scenario: 'opus', implement: 'sonnet', verify: 'sonnet', judge: 'opus', review: 'codex', sabotage: 'sonnet' },
  // runs_per_scenario: 1 シナリオを流す回数の上限。rerun が on_failure なら、落ちたときだけ上限まで流し直す（always なら毎回上限まで）
  satisfaction: { runs_per_scenario: 3, threshold: 0.95, rerun: 'on_failure' },
  max_rounds: 5,
  // 陰性対照。base: 実装の前に今のアプリでシナリオを流し、合格してしまうなら止める。mutant: マージの前に壊したアプリを流す
  control: { base: true, mutant: false },
  // 人がコードを読まない前提の品質関門。review は別のモデルのレビューを PR のレポートに載せる（マージは止めない）
  quality: { max_changed_lines: 800, require_tests: true, lint: null, review: true },
  protected_paths: ['**/*.entitlements', '.github/workflows/**', '.factory/**'],
  external_services: [],
  notify: { mac: true, pr_report: true },
}

const TYPES = ['ios']

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// オブジェクトは中まで合わせ、配列や値はプロジェクト側で置き換える。
function merge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v)
  return out
}

function check(ok, key, why) {
  if (!ok) throw new Error(`.factory/config.json の ${key} が不正です: ${why}`)
}

export function mergeConfig(project) {
  const c = merge(DEFAULTS, project)
  check(TYPES.includes(c.type), 'type', `${TYPES.join(' / ')} のどれか`)
  const { runs_per_scenario, threshold } = c.satisfaction
  check(Number.isInteger(runs_per_scenario) && runs_per_scenario >= 1, 'satisfaction.runs_per_scenario', '1 以上の整数')
  check(typeof threshold === 'number' && threshold > 0 && threshold <= 1, 'satisfaction.threshold', '0 より大きく 1 以下')
  check(Number.isInteger(c.max_rounds) && c.max_rounds >= 1, 'max_rounds', '1 以上の整数')
  check(['on_failure', 'always'].includes(c.satisfaction.rerun), 'satisfaction.rerun', 'on_failure / always のどちらか')
  check(Array.isArray(c.protected_paths), 'protected_paths', '文字列の配列')
  check(Number.isInteger(c.quality.max_changed_lines) && c.quality.max_changed_lines >= 1, 'quality.max_changed_lines', '1 以上の整数')
  check(c.quality.lint === null || typeof c.quality.lint === 'string', 'quality.lint', 'コマンドの文字列か null')
  const ui = c.ios.ui_tests
  check(ui === null || (typeof ui?.target === 'string' && typeof ui?.dir === 'string'), 'ios.ui_tests', '{ "target": "...", "dir": "..." } か null')
  // Codex のサンドボックスは読み取りを制限できず、隠しシナリオを読めてしまう。
  // 検証役は agent-device が手元のランナーと通信するので、ネットワークを止める Codex では動かない恐れがある。
  for (const role of ['implement', 'verify', 'sabotage']) check(!/^codex(:|$)/.test(c.models[role]), `models.${role}`, 'Codex は使えない（Claude のモデルにする）')
  return c
}

export function loadConfig(repo) {
  const file = join(repo, CONFIG_PATH)
  if (!existsSync(file)) throw new Error(`${file} がありません。先に /factory:init を実行してください`)
  return mergeConfig(JSON.parse(readFileSync(file, 'utf8')))
}
