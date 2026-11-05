// スキルから呼ぶ CLI。結果は JSON で出す。判定と採点は check.mjs（アプリのリポジトリに写すもの）を直接呼ぶ。
//   node cli.mjs install <repo> [--ci] [--pr-template] [--solo]   check.mjs を写し、ないものだけ設定とひな形を置く
//   node cli.mjs status <repo>                                     置いたものと、写した check.mjs が古いかどうか
//   node cli.mjs codeowners <repo> --owner <@name>                 高リスクのパスから CODEOWNERS を作る（あれば足す行を返す）
//   node cli.mjs round begin <repo> --branch <b> --head <sha> --base <sha>
//   node cli.mjs round record <repo> --branch <b> --head <sha> --base <sha> --file <json>
//   node cli.mjs round stats <repo>
//   node cli.mjs round reset <repo> --branch <b>
//   node cli.mjs eval new-id <repo>
//   node cli.mjs eval new-run <repo> --label <label> [--note <text>]
//   node cli.mjs outcome add <repo> --file <json>                  指摘への対応結果を review/outcomes.jsonl に足す
import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CASES_DIR, CONFIG_PATH, DEFAULT_CONFIG, OUTCOMES, OUTCOMES_PATH, RUNS_DIR, fingerprint, loadConfig, nextCaseId, parseArgs, readJson } from './check.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CHECK = join(ROOT, 'scripts', 'check.mjs')
const TEMPLATES = join(ROOT, 'templates')
export const VENDORED = 'review/check.mjs'

export function install(repo, { ci = false, prTemplate = false, solo = false } = {}) {
  const copied = []
  const updated = []
  const skipped = []
  const vendored = join(repo, VENDORED)
  mkdirSync(dirname(vendored), { recursive: true })
  if (!existsSync(vendored)) {
    copyFileSync(CHECK, vendored)
    copied.push(VENDORED)
  } else if (readFileSync(vendored, 'utf8') !== readFileSync(CHECK, 'utf8')) {
    copyFileSync(CHECK, vendored)
    updated.push(VENDORED)
  }
  const place = (from, to) => {
    const abs = join(repo, to)
    if (existsSync(abs)) return skipped.push(to)
    mkdirSync(dirname(abs), { recursive: true })
    copyFileSync(from, abs)
    copied.push(to)
  }
  if (existsSync(join(repo, CONFIG_PATH))) skipped.push(CONFIG_PATH)
  else {
    const config = structuredClone(DEFAULT_CONFIG)
    if (solo) config.approvals.high_needs_other = false
    writeFileSync(join(repo, CONFIG_PATH), JSON.stringify(config, null, 2) + '\n')
    copied.push(CONFIG_PATH)
  }
  place(join(TEMPLATES, 'repo', 'REVIEW.md'), 'REVIEW.md')
  place(join(TEMPLATES, 'repo', 'review', 'README.md'), 'review/README.md')
  for (const dir of [CASES_DIR, RUNS_DIR]) {
    if (existsSync(join(repo, dir))) continue
    mkdirSync(join(repo, dir), { recursive: true })
    writeFileSync(join(repo, dir, '.gitkeep'), '')
    copied.push(`${dir}/.gitkeep`)
  }
  if (ci) place(join(TEMPLATES, 'ci', 'layered-review.yml'), '.github/workflows/layered-review.yml')
  if (prTemplate) place(join(TEMPLATES, 'ci', 'pull_request_template.md'), '.github/pull_request_template.md')
  return { copied, updated, skipped }
}

export function status(repo) {
  const vendored = join(repo, VENDORED)
  return {
    installed: existsSync(join(repo, CONFIG_PATH)),
    vendored_check: !existsSync(vendored) ? 'missing' : readFileSync(vendored, 'utf8') === readFileSync(CHECK, 'utf8') ? 'ok' : 'stale',
    review_md: existsSync(join(repo, 'REVIEW.md')),
    ci: existsSync(join(repo, '.github/workflows/layered-review.yml')),
    codeowners: ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'].find((p) => existsSync(join(repo, p))) ?? null,
  }
}

// CODEOWNERS は後に書いた行が勝つので、高リスクのパスは末尾に足す
export function codeowners(repo, owner) {
  if (!/^@[\w.-]+(\/[\w.-]+)?$/.test(owner ?? '')) throw new Error('--owner は @user か @org/team の形')
  const { config, errors } = loadConfig(repo)
  if (errors.length) throw new Error(`${CONFIG_PATH} に誤りがある: ${errors.map((e) => e.message).join(' / ')}`)
  const lines = ['# layered-review: 高リスクのパスは人の承認を必須にする（review/config.json の risk.high から作った）']
  for (const [reason, globs] of Object.entries(config.risk.high)) {
    lines.push(`# ${reason}`)
    for (const g of globs) lines.push(`${g} ${owner}`)
  }
  const existing = status(repo).codeowners
  if (existing) return { path: existing, written: false, append: lines.join('\n') + '\n' }
  const path = '.github/CODEOWNERS'
  mkdirSync(join(repo, '.github'), { recursive: true })
  writeFileSync(join(repo, path), lines.join('\n') + '\n')
  return { path, written: true }
}

// ---- 往復の記録（コミットしない。git のディレクトリに置く） ----

function stateFile(repo) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('git のリポジトリではない')
  const gitDir = r.stdout.trim()
  return join(isAbsolute(gitDir) ? gitDir : join(repo, gitDir), 'layered-review', 'state.json')
}

function loadState(repo) {
  const file = stateFile(repo)
  const { value } = existsSync(file) ? readJson(file) : {}
  return { file, state: value && typeof value === 'object' && value.branches ? value : { branches: {} } }
}

function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n')
}

const isOpenImportant = (f) => f.status === 'open' && f.label === 'important'

export function roundBegin(repo, { branch, head, base }) {
  if (!branch || !head || !base) throw new Error('--branch・--head・--base を指定する')
  const { config } = loadConfig(repo)
  const { state } = loadState(repo)
  const rounds = state.branches[branch]?.rounds ?? []
  const last = rounds.at(-1)
  const all = rounds.flatMap((r) => r.findings)
  const max = config.review.max_rounds
  if (last && last.head === head)
    return { round: last.n, unchanged: true, scope: last.scope, diff_base: last.base, max_rounds: max, over_cap: last.n > max, previous_open: last.findings.filter((f) => f.status === 'open'), reported: all.map((f) => f.fp) }
  const n = rounds.length + 1
  return {
    round: n,
    unchanged: false,
    scope: n === 1 ? 'full' : 'diff',
    diff_base: n === 1 ? base : last.head,
    max_rounds: max,
    over_cap: n > max,
    previous_open: rounds.flatMap((r) => r.findings).filter((f) => f.status === 'open'),
    reported: all.map((f) => f.fp),
  }
}

// file: { findings: [{ path, line, class, title, severity, label: important|nit|pre-existing, origin }], previous: [{ fp, status }] }
export function roundRecord(repo, { branch, head, base, file }) {
  if (!branch || !head || !file) throw new Error('--branch・--head・--file を指定する')
  const { value, error } = readJson(resolve(file))
  if (error) throw new Error(`${file} が読めない: ${error}`)
  const findings = Array.isArray(value?.findings) ? value.findings : []
  const previous = Array.isArray(value?.previous) ? value.previous : []
  const { file: sf, state } = loadState(repo)
  const entry = (state.branches[branch] ??= { rounds: [], passed_round: null })
  const prior = entry.rounds.flatMap((r) => r.findings)
  for (const p of previous) {
    if (!['fixed', 'open', 'rejected', 'intentional', 'ignored'].includes(p?.status)) throw new Error(`previous の status が違う: ${JSON.stringify(p)}`)
    const f = prior.find((x) => x.fp === p.fp)
    if (f) f.status = p.status
  }
  const last = entry.rounds.at(-1)
  const unchanged = Boolean(last && last.head === head)
  const seen = new Set(prior.map((f) => f.fp))
  const fresh = []
  for (const f of findings) {
    if (!['important', 'nit', 'pre-existing'].includes(f?.label)) throw new Error(`findings の label は important / nit / pre-existing: ${JSON.stringify(f)}`)
    const fp = f.fp ?? fingerprint(f)
    if (seen.has(fp)) continue
    seen.add(fp)
    fresh.push({ fp, path: f.path ?? null, line: f.line ?? null, class: f.class ?? null, title: f.title ?? '', severity: f.severity ?? null, label: f.label, status: f.label === 'important' ? 'open' : 'noted' })
  }
  const n = unchanged ? last.n : entry.rounds.length + 1
  if (unchanged) last.findings.push(...fresh)
  else entry.rounds.push({ n, head, base: base ?? last?.head ?? null, scope: n === 1 ? 'full' : 'diff', at: new Date().toISOString(), findings: fresh })
  const open = entry.rounds.flatMap((r) => r.findings).filter(isOpenImportant)
  if (open.length === 0 && entry.passed_round === null) entry.passed_round = n
  saveState(sf, state)
  return { round: n, new_findings: fresh.length, skipped_duplicates: findings.length - fresh.length, open_important: open.length, passed: open.length === 0, passed_round: entry.passed_round }
}

export function roundStats(repo) {
  const { state } = loadState(repo)
  const rows = Object.entries(state.branches).map(([branch, e]) => ({ branch, rounds: e.rounds.length, passed_round: e.passed_round ?? null }))
  const passed = rows.filter((r) => r.passed_round !== null)
  return {
    branches: rows.length,
    passed: passed.length,
    avg_rounds_to_pass: passed.length ? passed.reduce((n, r) => n + r.passed_round, 0) / passed.length : null,
    max_rounds: rows.reduce((m, r) => Math.max(m, r.rounds), 0),
    rows,
  }
}

export function roundReset(repo, { branch }) {
  if (!branch) throw new Error('--branch を指定する')
  const { file, state } = loadState(repo)
  const had = Boolean(state.branches[branch])
  delete state.branches[branch]
  saveState(file, state)
  return { reset: had }
}

// ---- eval ----

export function newRun(repo, { label, note }) {
  if (!label || !/^[\w.-]+$/.test(label)) throw new Error('--label は英数字と . _ - だけ（例: review-md-v2）')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const rel = `${RUNS_DIR}/${stamp}-${label}`
  const abs = join(repo, rel)
  if (existsSync(abs)) throw new Error(`${rel} はもうある`)
  mkdirSync(join(abs, 'findings'), { recursive: true })
  mkdirSync(join(abs, 'judgments'), { recursive: true })
  const reviewMd = existsSync(join(repo, 'REVIEW.md')) ? readFileSync(join(repo, 'REVIEW.md'), 'utf8') : ''
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout?.trim() || null
  const meta = { label, at: new Date().toISOString(), note: note ?? '', repo_head: head, review_md_sha1: reviewMd ? fingerprint({ title: reviewMd }) : null }
  writeFileSync(join(abs, 'run.json'), JSON.stringify(meta, null, 2) + '\n')
  return { dir: rel }
}

// ---- 対応結果 ----

// file: [{ ref, fp?, path?, class, severity, title, outcome, reason? }]
export function outcomeAdd(repo, { file }) {
  const { value, error } = readJson(resolve(file ?? ''))
  if (error || !Array.isArray(value)) throw new Error(`--file は対応結果の配列の JSON にする${error ? `: ${error}` : ''}`)
  const at = new Date().toISOString()
  const rows = value.map((r) => {
    if (!OUTCOMES.includes(r?.outcome)) throw new Error(`outcome は ${OUTCOMES.join(' / ')} のどれか: ${JSON.stringify(r)}`)
    return JSON.stringify({ at, ref: r.ref ?? null, fp: r.fp ?? fingerprint(r), class: r.class ?? null, severity: r.severity ?? null, title: r.title ?? '', outcome: r.outcome, reason: r.reason ?? '' })
  })
  mkdirSync(dirname(join(repo, OUTCOMES_PATH)), { recursive: true })
  if (rows.length) appendFileSync(join(repo, OUTCOMES_PATH), rows.join('\n') + '\n')
  return { added: rows.length, path: OUTCOMES_PATH }
}

function main(argv) {
  const out = (v) => console.log(JSON.stringify(v, null, 2))
  const [cmd, ...rest] = argv
  const sub = ['round', 'eval', 'outcome'].includes(cmd) ? rest.shift() : null
  const { opts, pos } = parseArgs(rest, ['ci', 'pr-template', 'solo'])
  const repo = resolve(pos[0] ?? '.')
  switch (sub ? `${cmd} ${sub}` : cmd) {
    case 'install':
      return out(install(repo, { ci: Boolean(opts.ci), prTemplate: Boolean(opts['pr-template']), solo: Boolean(opts.solo) })), 0
    case 'status':
      return out(status(repo)), 0
    case 'codeowners':
      return out(codeowners(repo, opts.owner)), 0
    case 'round begin':
      return out(roundBegin(repo, opts)), 0
    case 'round record':
      return out(roundRecord(repo, opts)), 0
    case 'round stats':
      return out(roundStats(repo)), 0
    case 'round reset':
      return out(roundReset(repo, opts)), 0
    case 'eval new-id':
      return out({ id: nextCaseId(repo) }), 0
    case 'eval new-run':
      return out(newRun(repo, opts)), 0
    case 'outcome add':
      return out(outcomeAdd(repo, opts)), 0
    default:
      console.error('使い方: node cli.mjs install|status|codeowners|round begin|round record|round stats|round reset|eval new-id|eval new-run|outcome add <repo> …')
      return 2
  }
}

const isMain = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    console.error(`layered-review: ${e.message}`)
    process.exitCode = 2
  }
}
