// 工場の KPI。機能ごとに metrics.jsonl へ 1 行ずつ足していく（工程の時間と、役の呼び出しの時間・費用・トークン・拒否）。
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const file = (fdir) => join(fdir, 'metrics.jsonl')

export function record(fdir, entry) {
  appendFileSync(file(fdir), JSON.stringify(entry) + '\n')
}

export function readMetrics(fdir) {
  if (!existsSync(file(fdir))) return []
  return readFileSync(file(fdir), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

// claude -p --output-format json の結果から、費用・トークン・拒否された操作を取り出す。
export function callUsage(json) {
  const u = json?.usage ?? {}
  return {
    cost_usd: Number(json?.total_cost_usd) || 0,
    input_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    output_tokens: u.output_tokens ?? 0,
    denials: Array.isArray(json?.permission_denials) ? json.permission_denials : [],
  }
}

// 拒否された操作を、次の周の実装役に渡す「道具の注意」の 1 行にする。
export function describeDenial(d) {
  const input = d.tool_input?.command ?? d.tool_input?.file_path ?? JSON.stringify(d.tool_input ?? {})
  return `${d.tool_name}: ${String(input).split('\n')[0].slice(0, 160)}`
}

export function summarizeMetrics(entries) {
  const steps = {}
  const roles = {}
  let cost = 0
  let tokens = 0
  let denials = 0
  for (const e of entries) {
    if (e.type === 'step') steps[e.step] = (steps[e.step] ?? 0) + e.ms
    if (e.type === 'call') {
      const r = (roles[e.role] ??= { calls: 0, ms: 0, cost_usd: 0 })
      r.calls += 1
      r.ms += e.ms
      r.cost_usd += e.cost_usd ?? 0
      cost += e.cost_usd ?? 0
      tokens += (e.input_tokens ?? 0) + (e.output_tokens ?? 0)
      denials += e.denials ?? 0
    }
  }
  const total_ms = Object.values(steps).reduce((a, b) => a + b, 0)
  return { total_ms, steps, roles, cost_usd: cost, tokens, denials }
}

const min = (ms) => `${(ms / 60000).toFixed(1)} 分`

export function metricsTable(m) {
  const rows = Object.entries(m.steps).map(([step, ms]) => `| ${step} | ${min(ms)} |`)
  const roles = Object.entries(m.roles).map(([role, r]) => `| ${role} | ${r.calls} | ${min(r.ms)} | $${r.cost_usd.toFixed(2)} |`)
  return [
    `合計 ${min(m.total_ms)}、費用 $${m.cost_usd.toFixed(2)}（Claude の分）、トークン ${m.tokens.toLocaleString('en-US')}、実装役が拒否された操作 ${m.denials} 回`,
    '',
    '| 工程 | 時間 |',
    '| - | - |',
    ...rows,
    '',
    '| 役 | 呼び出し | 時間 | 費用 |',
    '| - | - | - | - |',
    ...roles,
  ].join('\n')
}
