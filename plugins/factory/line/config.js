// .factory/config.json を読み、既定値と合わせて検証する。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const CONFIG_PATH = join('.factory', 'config.json')

export const DEFAULTS = {
  type: null,
  ios: { project: null, scheme: null, bundle_id: null, device: 'iPhone 17', prebuild: null },
  autonomy: 5,
  models: { interview: 'opus', scenario: 'opus', implement: 'sonnet', verify: 'sonnet', judge: 'opus' },
  satisfaction: { runs_per_scenario: 3, threshold: 0.95 },
  max_rounds: 5,
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
  check(Array.isArray(c.protected_paths), 'protected_paths', '文字列の配列')
  return c
}

export function loadConfig(repo) {
  const file = join(repo, CONFIG_PATH)
  if (!existsSync(file)) throw new Error(`${file} がありません。先に /factory:init を実行してください`)
  return mergeConfig(JSON.parse(readFileSync(file, 'utf8')))
}
