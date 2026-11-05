// layered-review のチェッカー。アプリのリポジトリの review/check.mjs に写して、CI でもプラグインなしで動かす。依存はない。
//   node review/check.mjs [--repo <dir>] [--json]                              設定・eval のケース・実行結果の形を調べる
//   node review/check.mjs risk --base <ref> [--head <ref>] [--author <login>] [--repo <dir>] [--config <file>] [--json]
//                                                                             変更の中身からリスク段階・レビューの深さ・人の承認を決める
//   node review/check.mjs classify --base <ref> [--head <ref>] --findings <file> [--repo <dir>]
//                                                                             指摘を introduced / pre-existing に分ける
//   node review/check.mjs score <run-dir> [--repo <dir>] [--json]               eval の実行結果を採点する
//   node review/check.mjs compare <run-dir-a> <run-dir-b> [--repo <dir>] [--json] 2 回の実行を比べる（b が新しいほう）
//   node review/check.mjs outcomes [--repo <dir>] [--json]                      指摘への対応結果（review/outcomes.jsonl）を集計する
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CONFIG_PATH = 'review/config.json'
export const CASES_DIR = 'review/evals/cases'
export const RUNS_DIR = 'review/evals/runs'
export const OUTCOMES_PATH = 'review/outcomes.jsonl'

export const TIERS = ['low', 'standard', 'high']
export const MODES = ['quick', 'standard', 'deep']
export const SEVERITIES = ['critical', 'high', 'medium', 'low']
export const VERDICTS = ['tp', 'real_unlisted', 'noise', 'harmful']
export const OUTCOMES = ['fixed', 'rejected', 'intentional', 'ignored']

export const DEFAULT_CONFIG = {
  version: 1,
  // PR の前に回すチェック。「完了しました」ではなく結果を見せるために使う
  checks: [],
  risk: {
    // 理由ごとのパス。1 つでも当たれば high
    high: {
      '認証・認可': ['**/auth/**', '**/session/**'],
      '課金・決済': ['**/billing/**', '**/payment*/**', '**/purchase*/**'],
      'CI・リリース・自動更新': ['.github/workflows/**', '.github/CODEOWNERS', 'eas.json', '**/updates/**'],
      'データの形（マイグレーション・スキーマ）': ['**/migrations/**', '**/schema.*', '**/*.sql'],
      'アプリの設定・権限': ['app.json', 'app.config.*', '**/AndroidManifest.xml', '**/Info.plist'],
      'レビューの決まり': ['REVIEW.md', 'review/config.json', 'review/check.mjs'],
    },
    // すべてのファイルが当たれば low
    low: ['**/*.md', 'docs/**', 'features/**', '**/__snapshots__/**', 'review/evals/**'],
    // 追加と削除の行数の合計がこれを超えたら、段階は変えずにレビューを deep にする
    large_change_lines: 400,
  },
  review: {
    modes: { low: 'quick', standard: 'standard', high: 'deep' },
    // 1 つの PR でレビューを回す回数。超えたら、直し方ではなく方針の見直しを勧める
    max_rounds: 3,
  },
  approvals: {
    // 作者（エージェントが書いたなら、エージェントを動かした人）は、いつも責任を持つ 1 人に数える
    trusted_authors: [],
    // 低リスクを、自動のチェックが通ったら人の承認なしでマージしてよいか
    auto_merge_low: false,
    // 高リスクに、作者以外の人の承認を求めるか（1 人の開発なら false にして、作者が deep の結果を自分で確かめる）
    high_needs_other: true,
  },
  eval: {
    weights: { critical: 4, high: 2, medium: 1, low: 0.5 },
  },
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v
  return out
}

export function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (e) {
    return { error: e.message }
  }
}

// 設定の high は、上書きすると既定の理由と混ざらないように丸ごと置き換える
export function loadConfig(repo, file) {
  const abs = file ?? join(repo, CONFIG_PATH)
  if (!existsSync(abs)) {
    if (file) return { config: DEFAULT_CONFIG, errors: [{ file, rule: 'config', message: '設定のファイルがない' }] }
    return { config: DEFAULT_CONFIG, errors: [], missing: true }
  }
  const { value, error } = readJson(abs)
  if (error) return { config: DEFAULT_CONFIG, errors: [{ file: CONFIG_PATH, rule: 'parse', message: `JSON として読めない: ${error}` }] }
  const config = merge(DEFAULT_CONFIG, value)
  if (isObj(value?.risk) && isObj(value.risk.high)) config.risk.high = value.risk.high
  if (isObj(value?.risk) && Array.isArray(value.risk.low)) config.risk.low = value.risk.low
  return { config, errors: validateConfig(config) }
}

export function validateConfig(c) {
  const errors = []
  const err = (rule, message) => errors.push({ file: CONFIG_PATH, rule, message })
  if (!Array.isArray(c.checks)) err('checks', 'checks は配列にする')
  else
    c.checks.forEach((ch, i) => {
      if (!isObj(ch) || typeof ch.name !== 'string' || typeof ch.run !== 'string' || !ch.name || !ch.run) err('checks', `checks[${i}] には name と run（文字列）を書く`)
    })
  if (!isObj(c.risk?.high)) err('risk', 'risk.high は「理由: [パス]」のオブジェクトにする')
  else
    for (const [reason, globs] of Object.entries(c.risk.high))
      if (!Array.isArray(globs) || globs.some((g) => typeof g !== 'string' || !g.trim())) err('risk', `risk.high の「${reason}」はパスの配列にする`)
  if (!Array.isArray(c.risk?.low) || c.risk.low.some((g) => typeof g !== 'string' || !g.trim())) err('risk', 'risk.low はパスの配列にする')
  if (!Number.isInteger(c.risk?.large_change_lines) || c.risk.large_change_lines < 1) err('risk', 'risk.large_change_lines は 1 以上の整数にする')
  for (const t of TIERS) if (!MODES.includes(c.review?.modes?.[t])) err('review', `review.modes.${t} は ${MODES.join(' / ')} のどれか`)
  if (!Number.isInteger(c.review?.max_rounds) || c.review.max_rounds < 1) err('review', 'review.max_rounds は 1 以上の整数にする')
  if (!Array.isArray(c.approvals?.trusted_authors)) err('approvals', 'approvals.trusted_authors は配列にする')
  for (const k of ['auto_merge_low', 'high_needs_other']) if (typeof c.approvals?.[k] !== 'boolean') err('approvals', `approvals.${k} は true / false`)
  for (const s of SEVERITIES) if (typeof c.eval?.weights?.[s] !== 'number' || c.eval.weights[s] < 0) err('eval', `eval.weights.${s} は 0 以上の数`)
  return errors
}

// gitignore / CODEOWNERS に近いパスの書き方。/ を含まないものはどの階層の名前にも当たり、/ で終わるものはその下すべて
export function globToRegExp(glob) {
  let g = glob.trim()
  const anchored = g.startsWith('/')
  if (anchored) g = g.slice(1)
  const anywhere = !anchored && !g.replace(/\/$/, '').includes('/')
  if (g.endsWith('/')) g += '**'
  if (anywhere) g = `**/${g}`
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]
    if (ch === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path))
}

// git diff -U0 の出力を読む。ファイルごとに、追加した行の範囲と、行を消しただけの位置を持つ
export function parseDiff(text) {
  const files = []
  let cur = null
  let oldLeft = 0
  let newLeft = 0
  const unq = (p) => (p.startsWith('"') && p.endsWith('"') ? JSON.parse(p) : p)
  const strip = (p) => {
    const v = unq(p.trim())
    return v === '/dev/null' ? null : v.replace(/^[ab]\//, '')
  }
  for (const line of text.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) {
        cur.additions++
        newLeft--
        continue
      }
      if (line.startsWith('-')) {
        cur.deletions++
        oldLeft--
        continue
      }
      if (line.startsWith('\\')) continue
      oldLeft = newLeft = 0
    }
    if (line.startsWith('diff --git ')) {
      cur = { path: null, old_path: null, status: 'modified', added: [], removed_at: [], additions: 0, deletions: 0, binary: false }
      files.push(cur)
      const m = line.match(/^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/)
      if (m) {
        cur.old_path = m[1]
        cur.path = m[2]
      }
    } else if (!cur) continue
    else if (line.startsWith('new file mode')) cur.status = 'added'
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted'
    else if (line.startsWith('rename from ')) {
      cur.status = 'renamed'
      cur.old_path = line.slice('rename from '.length)
    } else if (line.startsWith('rename to ')) cur.path = line.slice('rename to '.length)
    else if (line.startsWith('Binary files ')) cur.binary = true
    else if (line.startsWith('--- ')) cur.old_path = strip(line.slice(4)) ?? cur.old_path
    else if (line.startsWith('+++ ')) {
      const p = strip(line.slice(4))
      if (p) cur.path = p
    } else if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (!m) continue
      oldLeft = m[2] === undefined ? 1 : Number(m[2])
      const start = Number(m[3])
      newLeft = m[4] === undefined ? 1 : Number(m[4])
      if (newLeft > 0) cur.added.push([start, start + newLeft - 1])
      else cur.removed_at.push(start)
    }
  }
  for (const f of files) {
    if (f.status === 'deleted') f.path = f.old_path
    if (f.status !== 'renamed' && f.old_path === f.path) f.old_path = null
  }
  return files
}

const git = (repo, args) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`)
  return r.stdout
}

// head を省くと、base との分岐点から作業ツリー（未コミット・まだ追跡していないファイルも）までを見る
export function diffFiles(repo, { base, head } = {}) {
  if (!base) throw new Error('--base を指定する（例: origin/main）')
  if (head) return { files: parseDiff(git(repo, ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', `${base}...${head}`])), range: `${base}...${head}` }
  const mb = git(repo, ['merge-base', base, 'HEAD']).trim()
  const files = parseDiff(git(repo, ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', mb]))
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  for (const path of untracked) {
    let n = 0
    try {
      const text = readFileSync(join(repo, path), 'utf8')
      n = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    } catch {}
    files.push({ path, old_path: null, status: 'added', added: n ? [[1, n]] : [], removed_at: [], additions: n, deletions: 0, binary: false, untracked: true })
  }
  return { files, range: `${mb.slice(0, 12)}..(作業ツリー)` }
}

export function classifyRisk(files, config, { author } = {}) {
  const reasons = []
  const high = []
  for (const [reason, globs] of Object.entries(config.risk.high)) {
    const hit = files.filter((f) => [f.path, f.old_path].some((p) => p && matchesAny(p, globs))).map((f) => f.path)
    if (hit.length) high.push({ reason, files: hit })
  }
  const lines = files.reduce((n, f) => n + f.additions + f.deletions, 0)
  const lowFiles = files.filter((f) => [f.path, f.old_path].every((p) => !p || matchesAny(p, config.risk.low)))
  let tier
  if (high.length) {
    tier = 'high'
    for (const h of high) reasons.push(`${h.reason}: ${h.files.join(', ')}`)
  } else if (files.length && lowFiles.length === files.length) {
    tier = 'low'
    reasons.push('文書・機能マスタなど、動作に関わらないファイルだけ')
  } else {
    tier = 'standard'
    reasons.push(files.length ? '動作に関わるファイルを含む' : '変更なし')
  }
  let mode = config.review.modes[tier]
  const large = lines > config.risk.large_change_lines
  if (large && mode !== 'deep') {
    mode = 'deep'
    reasons.push(`変更が大きい（${lines} 行 > ${config.risk.large_change_lines} 行）のでレビューを deep にする`)
  }
  const a = config.approvals
  const trusted = author ? a.trusted_authors.includes(author) : null
  let human
  if (tier === 'low') human = a.auto_merge_low ? 'none' : 'author'
  else if (tier === 'standard') human = trusted === false ? 'other' : 'author'
  else human = a.high_needs_other || trusted === false ? 'other' : 'author'
  const notes = []
  if (author && trusted === false) notes.push(`${author} は trusted_authors にないので、作者以外の人の承認が要る`)
  if (!author && tier !== 'low' && a.trusted_authors.length) notes.push('作者が分からないので trusted として扱った（--author で指定できる）')
  notes.push('エージェントの承認は人の承認に数えない。エージェントが書いた変更は、動かした人が作者として責任を持つ')
  return {
    tier,
    mode,
    reasons,
    human_approval: human,
    notes,
    lines,
    files: files.length,
    high,
  }
}

export function fingerprint(f) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim()
  return createHash('sha1').update(`${f.path ?? ''}\n${norm(f.class)}\n${norm(f.title)}`).digest('hex').slice(0, 12)
}

// 指摘の行が変更の中（追加した行か、消した位置のすぐそば）なら introduced。外でも、探した側が「この変更で表に出た」と根拠を書いていれば introduced
export function classifyFindings(findings, files, { near = 2 } = {}) {
  const byPath = new Map(files.map((f) => [f.path, f]))
  return findings.map((f) => {
    const file = byPath.get(f.path)
    const line = Number(f.line)
    let inDiff = false
    if (file) {
      if (!Number.isFinite(line) || file.status === 'added' || file.binary) inDiff = true
      else
        inDiff =
          file.added.some(([s, e]) => line >= s - near && line <= e + near) || file.removed_at.some((p) => Math.abs(line - p) <= near + 1)
    }
    const exposed = !inDiff && typeof f.caused_by_change === 'string' && f.caused_by_change.trim() !== ''
    return { ...f, fp: f.fp ?? fingerprint(f), in_diff: inDiff, origin: inDiff || exposed ? 'introduced' : 'pre-existing' }
  })
}

// ---- eval ----

const SHA = /^[0-9a-f]{7,40}$/

export function validateCase(c, file) {
  const errors = []
  const err = (rule, message) => errors.push({ file, rule, message })
  if (!isObj(c)) return [{ file, rule: 'parse', message: 'オブジェクトではない' }]
  if (typeof c.id !== 'string' || !/^C-\d{3,}$/.test(c.id)) err('id', 'id は C-001 の形')
  else if (!basename(file).startsWith(`${c.id}-`) && basename(file) !== `${c.id}.json`) err('filename', `ファイル名は ${c.id}-<名前>.json にする`)
  if (!['bug', 'clean'].includes(c.kind)) err('kind', 'kind は bug（バグを入れた変更）か clean（問題のない変更）')
  if (typeof c.title !== 'string' || !c.title.trim()) err('title', 'title を書く')
  if (!isObj(c.introduced) || !SHA.test(c.introduced.base ?? '') || !SHA.test(c.introduced.head ?? ''))
    err('introduced', 'introduced.base（変更の前）と introduced.head（変更のコミット）を SHA で書く')
  if (typeof c.verified_by !== 'string' || !c.verified_by.trim()) err('verified_by', 'verified_by（場所と内容を確かめた人）を書く')
  if (!Array.isArray(c.bugs)) err('bugs', 'bugs は配列にする')
  else {
    if (c.kind === 'bug' && c.bugs.length === 0) err('bugs', 'kind: bug には bugs を 1 つ以上書く')
    if (c.kind === 'clean' && c.bugs.length > 0) err('bugs', 'kind: clean の bugs は空にする')
    const seen = new Set()
    c.bugs.forEach((b, i) => {
      const at = `bugs[${i}]`
      if (!isObj(b)) return err('bugs', `${at} はオブジェクトにする`)
      if (typeof b.id !== 'string' || !b.id) err('bugs', `${at}.id を書く`)
      else if (seen.has(b.id)) err('bugs', `${at}.id ${b.id} が重複している`)
      else seen.add(b.id)
      if (typeof b.path !== 'string' || !b.path) err('bugs', `${at}.path を書く`)
      if (!Array.isArray(b.lines) || b.lines.length !== 2 || !b.lines.every(Number.isInteger) || b.lines[0] < 1 || b.lines[0] > b.lines[1])
        err('bugs', `${at}.lines は [始まり, 終わり]（1 以上の整数）`)
      if (!SEVERITIES.includes(b.severity)) err('bugs', `${at}.severity は ${SEVERITIES.join(' / ')} のどれか`)
      for (const k of ['description', 'trigger']) if (typeof b[k] !== 'string' || !b[k].trim()) err('bugs', `${at}.${k} を書く`)
    })
  }
  return errors
}

export function loadCases(repo) {
  const dir = join(repo, CASES_DIR)
  const cases = []
  const errors = []
  if (!existsSync(dir)) return { cases, errors }
  const ids = new Map()
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const file = `${CASES_DIR}/${name}`
    const { value, error } = readJson(join(dir, name))
    if (error) {
      errors.push({ file, rule: 'parse', message: `JSON として読めない: ${error}` })
      continue
    }
    const errs = validateCase(value, file)
    errors.push(...errs)
    if (isObj(value) && typeof value.id === 'string') {
      if (ids.has(value.id)) errors.push({ file, rule: 'id', message: `${value.id} は ${ids.get(value.id)} と重複している` })
      else ids.set(value.id, file)
    }
    if (!errs.length) cases.push({ ...value, file })
  }
  return { cases, errors }
}

export function nextCaseId(repo) {
  const dir = join(repo, CASES_DIR)
  let max = 0
  if (existsSync(dir)) for (const n of readdirSync(dir)) max = Math.max(max, Number(n.match(/^C-(\d+)/)?.[1] ?? 0))
  return `C-${String(max + 1).padStart(3, '0')}`
}

// 実行の置き場所: <run>/run.json、<run>/findings/<case>[.<n>].json、<run>/judgments/<case>[.<n>].json（n は繰り返しの番号）
export function loadRun(dir) {
  const errors = []
  const runFile = join(dir, 'run.json')
  const meta = existsSync(runFile) ? readJson(runFile) : { error: 'run.json がない' }
  if (meta.error) errors.push({ file: 'run.json', rule: 'run', message: meta.error })
  const read = (sub) => {
    const out = new Map()
    const d = join(dir, sub)
    if (!existsSync(d)) return out
    for (const name of readdirSync(d).filter((n) => n.endsWith('.json')).sort()) {
      const m = name.match(/^(C-\d+)(?:\.(\d+))?\.json$/)
      if (!m) {
        errors.push({ file: `${sub}/${name}`, rule: 'filename', message: 'ファイル名は C-001.json か C-001.2.json' })
        continue
      }
      const { value, error } = readJson(join(d, name))
      if (error) errors.push({ file: `${sub}/${name}`, rule: 'parse', message: error })
      else out.set(`${m[1]}#${m[2] ?? 1}`, value)
    }
    return out
  }
  return { meta: meta.value ?? {}, findings: read('findings'), judgments: read('judgments'), errors }
}

export function scoreRun(cases, run, config = DEFAULT_CONFIG) {
  const w = config.eval.weights
  const errors = [...run.errors]
  const byId = new Map(cases.map((c) => [c.id, c]))
  const perBug = new Map()
  let findingsTotal = 0
  let goodFindings = 0
  let harmfulTotal = 0
  let cleanRuns = 0
  let cleanFindings = 0
  let cleanHarmfulRuns = 0
  const unlisted = []
  const reps = new Set()
  for (const [key, j] of run.judgments) {
    const [caseId, rep] = key.split('#')
    reps.add(Number(rep))
    const c = byId.get(caseId)
    const file = `judgments/${caseId}${rep === '1' ? '' : `.${rep}`}.json`
    if (!c) {
      errors.push({ file, rule: 'case', message: `${caseId} のケースがない（消したなら、この実行は比べられない）` })
      continue
    }
    const findings = run.findings.get(key)
    if (!Array.isArray(findings)) {
      errors.push({ file, rule: 'findings', message: `findings/${caseId}${rep === '1' ? '' : `.${rep}`}.json がない` })
      continue
    }
    const verdicts = Array.isArray(j?.findings) ? j.findings : []
    if (verdicts.length !== findings.length || verdicts.some((v, i) => v?.index !== i || !VERDICTS.includes(v?.verdict)))
      errors.push({ file, rule: 'verdict', message: `findings の各指摘（${findings.length} 件、index 0 から）に verdict（${VERDICTS.join(' / ')}）を 1 つずつ付ける` })
    const caught = new Map((Array.isArray(j?.bugs) ? j.bugs : []).map((b) => [b?.bug, b]))
    for (const b of c.bugs) {
      const k = `${c.id}/${b.id}`
      const rec = perBug.get(k) ?? { case: c.id, bug: b.id, severity: b.severity, title: b.description, caught: 0, runs: 0 }
      const m = caught.get(b.id)
      if (!m) errors.push({ file, rule: 'bugs', message: `${b.id} の判定がない（caught: true / false を書く）` })
      else {
        rec.runs++
        if (m.caught === true) {
          rec.caught++
          const v = verdicts[m.finding]
          if (!Number.isInteger(m.finding) || v?.verdict !== 'tp') errors.push({ file, rule: 'bugs', message: `${b.id} を見つけたなら、finding に tp の指摘の index を書く` })
        }
      }
      perBug.set(k, rec)
    }
    findingsTotal += findings.length
    for (const v of verdicts) {
      if (v?.verdict === 'tp' || v?.verdict === 'real_unlisted') goodFindings++
      if (v?.verdict === 'harmful') harmfulTotal++
      if (v?.verdict === 'real_unlisted') unlisted.push({ case: c.id, rep: Number(rep), finding: findings[v.index] ?? null, note: v.note ?? '' })
    }
    if (c.kind === 'clean') {
      cleanRuns++
      cleanFindings += verdicts.filter((v) => v?.verdict === 'noise' || v?.verdict === 'harmful').length
      if (verdicts.some((v) => v?.verdict === 'harmful')) cleanHarmfulRuns++
    }
  }
  const judgedCases = new Set([...run.judgments.keys()].map((k) => k.split('#')[0]))
  const notRun = cases.filter((c) => !judgedCases.has(c.id)).map((c) => c.id)
  const bugs = [...perBug.values()]
  const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0)
  const ratio = (a, b) => (b === 0 ? null : a / b)
  const weighted = ratio(sum(bugs, (b) => w[b.severity] * b.caught), sum(bugs, (b) => w[b.severity] * b.runs))
  const severe = bugs.filter((b) => b.severity === 'critical' || b.severity === 'high')
  const precision = ratio(goodFindings, findingsTotal)
  const f1 = weighted === null || precision === null || weighted + precision === 0 ? null : (2 * weighted * precision) / (weighted + precision)
  return {
    ok: errors.length === 0,
    errors,
    label: run.meta.label ?? null,
    repeats: reps.size,
    cases: judgedCases.size,
    not_run: notRun,
    metrics: {
      weighted_recall: weighted,
      recall: ratio(sum(bugs, (b) => b.caught), sum(bugs, (b) => b.runs)),
      severe_recall: ratio(sum(severe, (b) => b.caught), sum(severe, (b) => b.runs)),
      precision,
      f1,
      findings: findingsTotal,
      harmful: harmfulTotal,
      clean_findings_per_run: ratio(cleanFindings, cleanRuns),
      clean_harmful_rate: ratio(cleanHarmfulRuns, cleanRuns),
    },
    bugs: bugs.map((b) => ({ ...b, rate: ratio(b.caught, b.runs) })),
    real_unlisted: unlisted,
  }
}

export function compareRuns(a, b) {
  const keys = Object.keys(b.metrics)
  const delta = {}
  for (const k of keys) delta[k] = a.metrics[k] === null || b.metrics[k] === null ? null : b.metrics[k] - a.metrics[k]
  const before = new Map(a.bugs.map((x) => [`${x.case}/${x.bug}`, x]))
  const regressions = []
  const improvements = []
  for (const x of b.bugs) {
    const p = before.get(`${x.case}/${x.bug}`)
    if (!p || p.rate === null || x.rate === null) continue
    if (x.rate < p.rate) regressions.push({ case: x.case, bug: x.bug, severity: x.severity, before: p.rate, after: x.rate })
    if (x.rate > p.rate) improvements.push({ case: x.case, bug: x.bug, severity: x.severity, before: p.rate, after: x.rate })
  }
  // 重い見逃しを先に
  const order = (x) => SEVERITIES.indexOf(x.severity)
  regressions.sort((x, y) => order(x) - order(y))
  const worse = []
  if (delta.weighted_recall !== null && delta.weighted_recall < 0) worse.push('重みつき recall が下がった')
  if (delta.severe_recall !== null && delta.severe_recall < 0) worse.push('critical / high の recall が下がった')
  if (delta.clean_harmful_rate !== null && delta.clean_harmful_rate > 0) worse.push('問題のない変更で、有害な指摘が増えた')
  if (delta.precision !== null && delta.precision < -0.05) worse.push('precision が 5 ポイント以上下がった')
  return { a: a.label, b: b.label, delta, regressions, improvements, worse, same_cases: a.cases === b.cases && a.repeats === b.repeats }
}

// ---- 対応結果 ----

export function readOutcomes(repo) {
  const abs = join(repo, OUTCOMES_PATH)
  const rows = []
  const errors = []
  if (!existsSync(abs)) return { rows, errors }
  readFileSync(abs, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (!line.trim()) return
      try {
        const r = JSON.parse(line)
        if (!OUTCOMES.includes(r.outcome)) errors.push({ file: OUTCOMES_PATH, rule: 'outcome', message: `${i + 1} 行目: outcome は ${OUTCOMES.join(' / ')} のどれか` })
        else rows.push(r)
      } catch (e) {
        errors.push({ file: OUTCOMES_PATH, rule: 'parse', message: `${i + 1} 行目: ${e.message}` })
      }
    })
  return { rows, errors }
}

export function outcomeStats(rows) {
  const by = (key) => {
    const out = {}
    for (const r of rows) {
      const k = r[key] ?? '（なし）'
      out[k] ??= Object.fromEntries(OUTCOMES.map((o) => [o, 0]))
      out[k][r.outcome]++
    }
    return out
  }
  const fixed = rows.filter((r) => r.outcome === 'fixed').length
  return {
    total: rows.length,
    acted_rate: rows.length ? fixed / rows.length : null,
    by_outcome: Object.fromEntries(OUTCOMES.map((o) => [o, rows.filter((r) => r.outcome === o).length])),
    by_severity: by('severity'),
    by_class: by('class'),
  }
}

// ---- 全体の形のチェック ----

export function runCheck(repo) {
  const { config, errors: cfgErrors, missing } = loadConfig(repo)
  const errors = [...cfgErrors]
  const warnings = []
  if (missing) warnings.push({ file: CONFIG_PATH, rule: 'config', message: '設定がないので既定値で動く（/layered-review:init で置ける）' })
  if (!existsSync(join(repo, 'REVIEW.md'))) warnings.push({ file: 'REVIEW.md', rule: 'review-md', message: 'REVIEW.md がない' })
  const { cases, errors: caseErrors } = loadCases(repo)
  errors.push(...caseErrors)
  const runsDir = join(repo, RUNS_DIR)
  let runs = 0
  if (existsSync(runsDir))
    for (const name of readdirSync(runsDir).sort()) {
      const d = join(runsDir, name)
      if (!statSync(d).isDirectory()) continue
      runs++
      const s = scoreRun(cases, loadRun(d), config)
      for (const e of s.errors) warnings.push({ ...e, file: `${RUNS_DIR}/${name}/${e.file}` })
    }
  const { errors: outErrors } = readOutcomes(repo)
  errors.push(...outErrors)
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts: { cases: cases.length, bug_cases: cases.filter((c) => c.kind === 'bug').length, clean_cases: cases.filter((c) => c.kind === 'clean').length, runs },
  }
}

// ---- 表示 ----

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`)
const num = (v) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(2))

export function riskMarkdown(r) {
  const human = { none: '人の承認なし（自動のチェックが通ればマージしてよい）', author: '作者が確かめる（作者以外の承認は不要）', other: '作者以外の人の承認が要る' }[r.human_approval]
  return [
    `## レビューのリスク段階: **${r.tier}**`,
    '',
    `- レビューの深さ: ${r.mode}`,
    `- 人の承認: ${human}`,
    `- 変更: ${r.files} ファイル・${r.lines} 行`,
    ...r.reasons.map((x) => `- 理由: ${x}`),
    ...r.notes.map((x) => `- 注: ${x}`),
    '',
  ].join('\n')
}

export function scoreMarkdown(s) {
  const m = s.metrics
  const lines = [
    `## eval: ${s.label ?? '(ラベルなし)'}（${s.cases} ケース × ${s.repeats} 回）`,
    '',
    '| 指標 | 値 |',
    '| :- | -: |',
    `| 重みつき recall | ${pct(m.weighted_recall)} |`,
    `| critical / high の recall | ${pct(m.severe_recall)} |`,
    `| recall | ${pct(m.recall)} |`,
    `| precision | ${pct(m.precision)} |`,
    `| F1（重みつき recall と precision） | ${pct(m.f1)} |`,
    `| 問題のない変更 1 回あたりの指摘 | ${num(m.clean_findings_per_run)} |`,
    `| 問題のない変更で有害な指摘が出た割合 | ${pct(m.clean_harmful_rate)} |`,
    '',
  ]
  const missed = s.bugs.filter((b) => b.rate !== null && b.rate < 1)
  if (missed.length) {
    lines.push('### 見逃したバグ', '')
    for (const b of missed) lines.push(`- ${b.case}/${b.bug}（${b.severity}）: ${b.caught}/${b.runs} 回 — ${b.title}`)
    lines.push('')
  }
  if (s.real_unlisted.length) lines.push(`### 正解にない本物の指摘: ${s.real_unlisted.length} 件（ケースに足すか確かめる）`, '')
  if (s.not_run.length) lines.push(`未実行のケース: ${s.not_run.join(', ')}`, '')
  if (s.errors.length) lines.push('### 誤り', '', ...s.errors.map((e) => `- ${e.file}: ${e.message}`), '')
  return lines.join('\n')
}

export function compareMarkdown(c) {
  const rows = Object.entries(c.delta).map(([k, v]) => `| ${k} | ${v === null ? '—' : (v > 0 ? '+' : '') + (k.includes('per_run') || k === 'findings' || k === 'harmful' ? num(v) : `${(v * 100).toFixed(1)}pt`)} |`)
  const out = [`## ${c.a ?? 'a'} → ${c.b ?? 'b'}`, '', `判定: ${c.worse.length ? `悪化（${c.worse.join('・')}）` : '悪化なし'}`, '', '| 指標 | 差 |', '| :- | -: |', ...rows, '']
  if (!c.same_cases) out.push('注: ケース数か繰り返しの回数が違う。差はそのまま比べられない', '')
  if (c.regressions.length) out.push('### 見つけられなくなったバグ', '', ...c.regressions.map((r) => `- ${r.case}/${r.bug}（${r.severity}）: ${pct(r.before)} → ${pct(r.after)}`), '')
  if (c.improvements.length) out.push('### 見つけられるようになったバグ', '', ...c.improvements.map((r) => `- ${r.case}/${r.bug}（${r.severity}）: ${pct(r.before)} → ${pct(r.after)}`), '')
  return out.join('\n')
}

// ---- CLI ----

export function parseArgs(argv, flags = ['json', 'markdown']) {
  const opts = {}
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--') && flags.includes(a.slice(2))) opts[a.slice(2)] = true
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i]
    else pos.push(a)
  }
  return { opts, pos }
}

function main(argv) {
  const known = ['risk', 'classify', 'score', 'compare', 'outcomes']
  const cmd = known.includes(argv[0]) ? argv[0] : 'check'
  const { opts, pos } = parseArgs(cmd === 'check' ? argv : argv.slice(1))
  const repo = resolve(opts.repo ?? (cmd === 'check' ? pos[0] : undefined) ?? '.')
  // --config で、別のリポジトリ（eval では今のリポジトリ）の設定を使える
  const { config, errors: cfgErrors } = loadConfig(repo, opts.config ? resolve(opts.config) : undefined)
  const print = (v, md) => console.log(opts.json ? JSON.stringify(v, null, 2) : md(v))
  if (cmd !== 'check' && cmd !== 'outcomes' && cfgErrors.length) {
    for (const e of cfgErrors) console.error(`${e.file}: ${e.message}`)
    return 2
  }
  switch (cmd) {
    case 'risk': {
      const { files, range } = diffFiles(repo, { base: opts.base, head: opts.head })
      print({ range, ...classifyRisk(files, config, { author: opts.author }) }, riskMarkdown)
      return 0
    }
    case 'classify': {
      if (!opts.findings) throw new Error('--findings <file> を指定する')
      const { value, error } = readJson(resolve(opts.findings))
      if (error || !Array.isArray(value)) throw new Error(`findings は指摘の配列の JSON にする${error ? `: ${error}` : ''}`)
      const { files } = diffFiles(repo, { base: opts.base, head: opts.head })
      console.log(JSON.stringify(classifyFindings(value, files), null, 2))
      return 0
    }
    case 'score': {
      if (!pos[0]) throw new Error('実行のディレクトリを指定する')
      const s = scoreRun(loadCases(repo).cases, loadRun(resolve(repo, pos[0])), config)
      print(s, scoreMarkdown)
      return s.ok ? 0 : 1
    }
    case 'compare': {
      if (pos.length < 2) throw new Error('比べる 2 つの実行のディレクトリを指定する（古いほうが先）')
      const { cases } = loadCases(repo)
      const [a, b] = pos.map((p) => scoreRun(cases, loadRun(resolve(repo, p)), config))
      const c = compareRuns(a, b)
      print(c, compareMarkdown)
      return c.worse.length ? 1 : 0
    }
    case 'outcomes': {
      const { rows, errors } = readOutcomes(repo)
      const s = { ...outcomeStats(rows), errors }
      print(s, (v) => [`## 指摘への対応（${v.total} 件）`, '', `- 直した割合: ${pct(v.acted_rate)}`, ...OUTCOMES.map((o) => `- ${o}: ${v.by_outcome[o]}`), ''].join('\n'))
      return errors.length ? 1 : 0
    }
    default: {
      const r = runCheck(repo)
      print(r, (v) =>
        [
          v.ok ? `layered-review: 問題なし（ケース ${v.counts.cases} 件・実行 ${v.counts.runs} 回）` : `layered-review: 誤り ${v.errors.length} 件`,
          ...v.errors.map((e) => `  ✗ ${e.file} [${e.rule}] ${e.message}`),
          ...v.warnings.map((e) => `  ! ${e.file} [${e.rule}] ${e.message}`),
        ].join('\n'),
      )
      return r.ok ? 0 : 1
    }
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
