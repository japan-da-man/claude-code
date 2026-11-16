// 自動改善の状態：ロック、対象の選び方、歯止め、失敗票の下書き、実行の記録、未確認の自動変更、セッション開始時の知らせ。
// 対象の並べ替えと歯止めは、ここで機械的に決める（LLM には選ばせない）。
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUG_CATEGORY, DAY_MS, OTHER_CATEGORY, PREFERENCE_CATEGORY, activeLock, dayOf, daysBetween, isKnownSession, iso, listFiles, now,
  parseFrontmatter, readJson, safeId, withLock, writeFileAtomic, writeJson,
} from './core.mjs'
import { loadCandidates, markCandidates, rankTargets, summarizeKeys } from './candidates.mjs'
import {
  getRule, listRules, listSkills, measureAlwaysLoaded, readSkill, removeRule, removeSkill, renderRule, ruleCapacity, skillCapacity,
} from './trial.mjs'

const EMPTY = { last_run_at: null, changes: [], rejected: {}, recurrences: {}, promoted: {}, reports: [], notices: {}, auto_sessions: {} }
// セッション開始時の知らせ（報告の 1 行と、1 回きりの知らせ）を出し続ける日数。
export const NOTICE_DAYS = 7

export function loadAuto(ctx) {
  const raw = readJson(ctx.dirs.auto, {}) || {}
  return { ...structuredClone(EMPTY), ...raw }
}

// 状態ファイルを、排他をかけて書き換える。
export function updateAuto(ctx, fn) {
  return withLock(ctx.dirs.state, () => {
    const state = loadAuto(ctx)
    const result = fn(state)
    writeJson(ctx.dirs.auto, state)
    return result
  })
}

export const unreviewed = (state) => state.changes.filter((c) => !c.reviewed_at)

// lock を試みたセッション（実行できたかどうかは問わない）。
export function isAutoSession(ctx, sessionId = ctx.sessionId) {
  return Boolean(sessionId) && Boolean(loadAuto(ctx).auto_sessions[safeId(sessionId)])
}

// ---- 対象 ----

export function computeTargets(ctx, state = loadAuto(ctx)) {
  const rules = new Map(listRules(ctx).map((r) => [r.cause_key, r]))
  const skills = new Map(listSkills(ctx).map((s) => [s.cause_key, s]))
  // 追加できるかどうかは、対象を決める時点で分かる。追加できない対象は、下書きで候補を消費させない。
  const rule = ruleCapacity(ctx)
  const skill = skillCapacity(ctx)
  return rankTargets(loadCandidates(ctx), ctx.config, { rejected: state.rejected }).map((entry) => {
    const trialRule = rules.get(entry.key) ?? null
    const trialSkill = skills.get(entry.key) ?? null
    const promoted = state.promoted[entry.key] ?? null
    const recurrence = trialRule || trialSkill || promoted
    const no = recurrence ? (state.recurrences[entry.key]?.count ?? 0) + 1 : 0
    let allowed
    let blocked = null
    if (recurrence) {
      // 再発の 1 回目だけ、試用ルールを編集してよい。2 回目以降と、昇格済み・Skill の再発は案だけ。
      allowed = trialRule && !promoted && no === 1 ? ['trial edit'] : []
    } else {
      allowed = [rule.ok ? 'trial add' : null, skill.ok ? 'skill add' : null].filter(Boolean)
      if (!allowed.length) blocked = `${rule.reason}。${skill.reason}`
    }
    return {
      key: entry.key,
      category: entry.category,
      sessions: entry.sessions,
      latest: entry.latest,
      mode: recurrence ? 'recurrence' : 'new',
      recurrence_no: no,
      trial: trialRule ? 'rule' : trialSkill ? 'skill' : promoted ? 'promoted' : null,
      allowed,
      blocked,
      limits: recurrence ? null : { rule: rule.reason, skill: skill.reason },
    }
  })
}

// 実行の間隔。日時はスケジュール済みタスクの側で決めるので、interval_days は 2 つの意味で使う。
//   due      前回から interval_days の半分がたっている（これより短い間隔では動かさない。二重実行を防ぐ）
//   overdue  前回から interval_days を過ぎている（実行されていないと知らせる）
// 追いかけの実行（月曜の予定が火曜の夜に動く、など）のあとでも、翌週の定時の実行が飛ばないよう、
// 動かさない間隔は短くしてある。
export function intervalState(ctx, state = loadAuto(ctx)) {
  const days = ctx.config.auto.interval_days
  if (!days) return { enabled: false, due: false, overdue: false, last_run_at: state.last_run_at, next_run_from: null }
  const interval = days * DAY_MS
  const last = state.last_run_at ? new Date(state.last_run_at).getTime() : null
  const elapsed = last === null ? Infinity : now().getTime() - last
  // 二重実行を防ぐ最小の間隔は、間隔の半分。追いかけ実行や手動の実行のあとでも、次の定時の実行は飛ばない。
  // 「実行されていません」と知らせるのは、間隔を過ぎたとき。
  return {
    enabled: true,
    due: elapsed >= interval / 2,
    overdue: elapsed > interval,
    last_run_at: state.last_run_at,
    next_run_from: last === null ? null : new Date(last + interval / 2).toISOString(),
  }
}

// 自動改善が追加をやめている理由（セッション開始時と lock のときに知らせる）。
export function blockedReasons(ctx, state = loadAuto(ctx)) {
  const reasons = []
  const max = ctx.config.auto.max_unreviewed
  const pending = unreviewed(state).length
  if (max > 0 && pending >= max) reasons.push(`未確認の自動変更が上限（${max}件）に達している`)
  const rule = ruleCapacity(ctx)
  if (!rule.ok) reasons.push(rule.reason)
  return reasons
}

// ---- ロック ----

// 自動改善のセッションを登録する。間隔がたっていなければ登録せず、何もしないよう伝える。
// 登録を試みたセッションは、成否にかかわらず「自動改善のセッション」として覚えておく
// （ロックが外れたあと・始まらなかったあとも、ガードが書き込みに確認を挟むため）。
export function acquireLock(ctx, sessionId) {
  const sid = safeId(sessionId)
  return updateAuto(ctx, (state) => {
    const cutoff = now().getTime() - 14 * DAY_MS
    for (const [id, at] of Object.entries(state.auto_sessions)) {
      if (new Date(at).getTime() < cutoff) delete state.auto_sessions[id]
    }
    state.auto_sessions[sid] = iso()

    const existing = activeLock(ctx)
    if (existing?.broken) return { run: false, reason: 'broken', message: 'ロックのファイル（lock.json）を読めません。何もせず終了してください。' }
    if (existing && existing.session_id === sid) return { run: true, resumed: true, lock: existing }
    if (existing) return { run: false, reason: 'locked', message: '別のセッションが自動改善を実行中です。何もせず終了してください。' }

    const interval = intervalState(ctx, state)
    if (!interval.enabled) {
      return { run: false, reason: 'disabled', message: '自動改善は止めてあります（auto.interval_days が 0）。何もせず終了してください。' }
    }
    if (!interval.due) {
      return { run: false, reason: 'interval', message: `前回の実行（${dayOf(new Date(state.last_run_at))}）から間隔がたっていません。何もせず終了してください。` }
    }
    // このセッションを hook が見ていること（SessionStart か UserPromptSubmit が記録を残していること）を確かめる。
    // hook が動いていない、またはセッション ID が hook の見ているものと違うと、書き込みの拒否が効かないため。
    if (!isKnownSession(ctx, sid)) {
      return {
        run: false,
        reason: 'unknown_session',
        message: `セッション ${sid} は、このプラグインの hook に記録されていません（hook が動いていないか、セッション ID が違います）。書き込みの拒否が効かないおそれがあるので、自動改善を始めません。何もせず終了してください。`,
      }
    }
    const targets = computeTargets(ctx, state).slice(0, ctx.config.auto.max_per_run)
    const lock = { session_id: sid, at: iso(), targets, done: {}, counted: {}, report: null }
    writeJson(ctx.dirs.lock, lock)
    state.last_run_at = lock.at
    return { run: true, resumed: false, lock }
  })
}

// ロックを外す。外せるのは、ロックしたセッション自身が、実行の記録（report write）を書いたあとだけ。
export function releaseLock(ctx, sessionId) {
  const lock = activeLock(ctx)
  if (!lock) return { released: false, reason: 'none' }
  if (lock.broken || lock.session_id !== safeId(sessionId)) return { released: false, reason: 'other' }
  if (!lock.report) return { released: false, reason: 'no_report' }
  rmSync(ctx.dirs.lock, { force: true })
  return { released: true, lock }
}

function updateLock(ctx, lock, fn) {
  const current = readJson(ctx.dirs.lock)
  if (!current || current.session_id !== lock.session_id) return
  fn(current)
  writeJson(ctx.dirs.lock, current)
}

// ---- 歯止め ----

const NO_CONVERSION = ['environment', 'one_off']

// 自動改善のセッションでの書き込みを、その場の状態で判定する。
// op は 'pending add' | 'trial add' | 'trial edit' | 'skill add'。
export function autoGate(ctx, lock, op, key, { proposal = false, rootCause = null } = {}) {
  const target = lock.targets.find((t) => t.key === key)
  if (!target) {
    const keys = lock.targets.map((t) => t.key).join('、') || 'なし'
    return { ok: false, reason: `${key} は、今回の対象ではありません（今回の対象：${keys}）。対象はスクリプトが決めます。報告にだけ書いてください。` }
  }
  const state = loadAuto(ctx)
  const max = ctx.config.auto.max_unreviewed
  // この実行でこの原因について作った分（下書き）は、数に入れない。
  const pendingReview = unreviewed(state).filter((c) => !(c.session_id === lock.session_id && c.cause_key === key)).length
  if (pendingReview >= max) {
    return { ok: false, reason: `未確認の自動変更が ${pendingReview} 件あります（上限 ${max} 件）。追加も編集もせず、報告だけにしてください。` }
  }
  if (op === 'pending add') {
    // 追加できない対象は、下書きを作らせない（候補だけが消費されて、毎回同じ見送りになるのを防ぐ）。
    // 案を載せるとき（--proposal-kind）と、対策を入れない記録（環境が原因、再現しない）は別。
    if (target.blocked && !proposal && !NO_CONVERSION.includes(rootCause)) {
      return { ok: false, reason: `${key} には、いま試用を追加できません（${target.blocked}）。下書きは作らず、候補は残します。追加できない理由を報告に書いてください。` }
    }
    return { ok: true, target }
  }

  if (lock.done[key]) {
    return { ok: false, reason: `${key} には、この実行ですでに対策を入れました（${lock.done[key]}）。1 つの原因につき、変換は 1 つです。` }
  }
  if (!target.allowed.includes(op)) {
    if (target.mode === 'recurrence') {
      const hint = target.allowed.includes('trial edit')
        ? '再発の 1 回目なので、trial edit で文言を直せます。'
        : '再発の 2 回目以降（または昇格済み・Skill の再発）なので、編集しません。ガードや検証コマンドへ移す案を pending add --proposal-kind で報告に載せてください。'
      return { ok: false, reason: `${key} は試用中の原因の再発（${target.recurrence_no} 回目）です。${hint}` }
    }
    if (op === 'trial add' && target.limits?.rule) return { ok: false, reason: `${target.limits.rule}。追加せず、報告に書いてください。` }
    if (op === 'skill add' && target.limits?.skill) return { ok: false, reason: `${target.limits.skill}。追加せず、報告に書いてください。` }
    return { ok: false, reason: `${key} には試用がまだありません。trial add か skill add を使ってください。` }
  }
  if (!existsSync(pendingFile(ctx, key))) {
    return { ok: false, reason: `先に pending add で ${key} の失敗票の下書きを作ってください。` }
  }
  // この実行の途中で上限に達することもあるので、追加の直前にも確かめる。
  if (op === 'trial add') {
    const rule = ruleCapacity(ctx)
    if (!rule.ok) return { ok: false, reason: `${rule.reason}。追加せず、報告に書いてください。` }
  }
  if (op === 'skill add') {
    const skill = skillCapacity(ctx)
    if (!skill.ok) return { ok: false, reason: `${skill.reason}。追加せず、報告に書いてください。` }
  }
  return { ok: true, target }
}

// 自動改善がしたことを、未確認の自動変更として登録する。1 回の実行で、1 つの原因につき 1 件。
// kind は 'draft'（下書きだけ。対策は入れていない）、'proposal'（承認待ちの案）、
// 'trial_add' / 'trial_edit' / 'skill_add'（試用を入れた）。下書きに対策が続いたら、同じ 1 件を書き換える。
const CONVERSIONS = ['trial_add', 'trial_edit', 'skill_add']

export function registerChange(ctx, lock, { kind, key, ref }) {
  const change = updateAuto(ctx, (state) => {
    const mine = state.changes.find((c) => !c.reviewed_at && c.session_id === lock.session_id && c.cause_key === key)
    if (mine) {
      const upgrade = CONVERSIONS.includes(kind) || (kind === 'proposal' && mine.kind === 'draft')
      if (upgrade) {
        if (mine.kind === 'proposal') mine.proposal = true
        mine.kind = kind
        mine.ref = ref
      } else if (kind === 'proposal') {
        mine.proposal = true
      }
      return mine
    }
    const created = {
      id: `a-${safeId(key)}-${Date.now().toString(36)}`, kind, cause_key: key, ref, at: iso(), session_id: lock.session_id, report: null, reviewed_at: null, decision: null,
    }
    state.changes.push(created)
    return created
  })
  if (CONVERSIONS.includes(kind)) {
    updateLock(ctx, lock, (current) => {
      current.done[key] = kind
    })
  }
  return change
}

// 自動改善の実行中に、ロックしたセッション以外から入った試用。名乗ったセッションが本当かどうかは
// harness-note からは確かめきれないので、人の確認に回す（未確認の自動変更として登録する）。
export function registerDuringLock(ctx, { kind, key, ref, session }) {
  return updateAuto(ctx, (state) => {
    const created = {
      id: `a-${safeId(key)}-${Date.now().toString(36)}x`, kind, cause_key: key, ref, at: iso(), session_id: session, during_lock: true, report: null, reviewed_at: null, decision: null,
    }
    state.changes.push(created)
    return created
  })
}

// ---- 失敗票の下書き ----

export const ROOT_CAUSES = ['knowledge', 'procedure', 'forbidden', 'verification', 'structure', 'judgment', 'environment', 'one_off']
export const SIGNALS = ['tool_failure', 'human_correction', 'guard_denied', 'verify_failed', 'noticed']
export const PROPOSAL_KINDS = ['guard', 'verify', 'edit']

export function pendingFile(ctx, key) {
  return join(ctx.dirs.pending, `${safeId(key)}.md`)
}

export function listPending(ctx) {
  return listFiles(ctx.dirs.pending, (f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
}

export function readPending(ctx, key) {
  try {
    return readFileSync(pendingFile(ctx, key), 'utf8')
  } catch {
    return null
  }
}

export function incidentFiles(root) {
  const dir = join(root, 'harness', 'incidents')
  const out = []
  for (const file of listFiles(dir, (f) => /^INC-\d{4}-\d{4}\.md$/.test(f))) {
    let text = ''
    try {
      text = readFileSync(join(dir, file), 'utf8')
    } catch {
      continue
    }
    out.push({ id: file.replace(/\.md$/, ''), file: `harness/incidents/${file}`, data: parseFrontmatter(text).data ?? {} })
  }
  return out
}

export function nextIncidentId(root) {
  const year = dayOf().slice(0, 4)
  const numbers = incidentFiles(root).filter((i) => i.id.startsWith(`INC-${year}-`)).map((i) => Number(i.id.slice(-4)))
  return `INC-${year}-${String(Math.max(0, ...numbers) + 1).padStart(4, '0')}`
}

const one = (value) => String(value ?? '').replace(/\r\n/g, '\n').trim()

// 下書きを作り、材料にした候補を consumed にする。試用中の原因なら、再発として数える。
// lock は、自動改善のセッションから呼ばれたときのロック（人が呼んだときは null）。
export function addPending(ctx, input, lock = null) {
  const { key, category, signal, rootCause, severity, area, asked, expected, actual, evidence, proposalKind, proposal, by } = input
  const candidates = loadCandidates(ctx).filter((c) => c.cause_key === key && c.status === 'new')
  const related = incidentFiles(ctx.repo.root).filter((i) => i.data.cause_key === key).map((i) => i.id)
  const episodes = [...new Set(candidates.map((c) => c.episode).filter(Boolean))]
  const sessions = [...new Set(candidates.map((c) => c.session_id))]
  const sections = [
    '## 何を頼んだか', '', one(asked), '',
    '## 期待した結果', '', one(expected), '',
    '## 実際の結果', '', one(actual), '',
    '## 根拠', '',
    ...(one(evidence) ? [one(evidence), ''] : []),
    ...candidates.map((c) => `- 改善候補 ${c.id}（${c.at.slice(0, 10)}、${c.category}）：${c.text}`),
    ...(sessions.length ? [`- セッション：${sessions.join('、')}`] : []),
    ...(episodes.length ? [`- 事象メモ：${episodes.join('、')}`] : []),
    '',
  ]
  if (proposalKind) {
    const label = { guard: 'ガード', verify: '検証コマンド', edit: 'git 管理下のファイルの編集' }[proposalKind]
    sections.push(`## 承認待ちの案（${label}）`, '', one(proposal), '')
  }
  const file = pendingFile(ctx, key)
  const existing = readPending(ctx, key)
  // 同じ実行の 2 回目（試用を入れたあとに案を足す、など）は、再発ではない。
  const sameRun = Boolean(lock && (lock.done?.[key] || lock.counted?.[key] || lock.drafted?.[key]))
  let text
  if (existing) {
    const heading = sameRun ? `# 追記（${dayOf()}）` : `# 再発（${dayOf()}）`
    text = `${existing.replace(/\s+$/, '')}\n\n---\n\n${heading}\n\n${sections.join('\n')}`
  } else {
    const frontmatter = [
      '---',
      `id: DRAFT-${key}`,
      `date: ${dayOf()}`,
      `area: ${area || 'unknown'}`,
      `category: ${category}`,
      `signal: ${signal}`,
      `root_cause: ${rootCause}`,
      `cause_key: ${key}`,
      `related: [${related.join(', ')}]`,
      `severity: ${severity}`,
      'status: open',
      'control: null',
      `applied_by: ${by === 'auto' ? 'auto' : 'human'}`,
      'trial_started_at: null',
      'promoted_at: null',
      '---',
      '',
    ]
    text = `${frontmatter.join('\n')}\n${sections.join('\n')}`
  }
  mkdirSync(ctx.dirs.pending, { recursive: true })
  writeFileAtomic(file, text)
  const consumed = markCandidates(ctx, (c) => c.cause_key === key && c.status === 'new', 'consumed', { consumed_by: `pending:${key}` })

  let recurrence = null
  const trial = getRule(ctx, key) || listSkills(ctx).find((s) => s.cause_key === key) || loadAuto(ctx).promoted[key]
  if (trial && !sameRun) {
    recurrence = updateAuto(ctx, (state) => {
      const entry = state.recurrences[key] ?? { count: 0, at: [] }
      entry.count += 1
      entry.at = [...entry.at, iso()].slice(-10)
      state.recurrences[key] = entry
      return entry.count
    })
  }
  if (lock) {
    updateLock(ctx, lock, (current) => {
      current.drafted = { ...(current.drafted ?? {}), [key]: true }
      if (recurrence) current.counted = { ...(current.counted ?? {}), [key]: true }
    })
  }
  return { file, consumed, related, recurrence }
}

// 下書きの先頭を、試用を置いた状態に書き換える（status: trial、control、trial_started_at）。
export function markPendingTrial(ctx, key, control) {
  const text = readPending(ctx, key)
  if (!text) return
  const head = /^---\n[\s\S]*?\n---/.exec(text)
  if (!head) return
  const updated = head[0]
    .replace(/^status:.*$/m, 'status: trial')
    .replace(/^control:.*$/m, `control: ${control}`)
    .replace(/^trial_started_at:.*$/m, `trial_started_at: ${dayOf()}`)
  writeFileAtomic(pendingFile(ctx, key), updated + text.slice(head[0].length))
}

export function removePending(ctx, key) {
  const file = pendingFile(ctx, key)
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}

// ---- 断られた原因 ----

// 人が「消す」「対応しない」を選んだ原因。いまある候補は数えず、このあとの候補が新たにたまるまで対象にしない。
export function rejectCause(ctx, key) {
  const marked = markCandidates(ctx, (c) => c.cause_key === key && c.status === 'new', 'rejected')
  updateAuto(ctx, (state) => {
    state.rejected[key] = { at: iso() }
  })
  return marked.length
}

// ---- 実行の記録 ----

const COUNT_LABELS = [
  ['trial_add', '試用ルールを', '件追加'],
  ['trial_edit', '', '件を編集'],
  ['skill_add', '試用Skillを', '件追加'],
]

export function countChanges(changes) {
  const counts = { trial_add: 0, trial_edit: 0, skill_add: 0, proposal: 0, draft: 0 }
  for (const c of changes) {
    if (c.kind in counts) counts[c.kind] += 1
    // 試用と案の両方を出したものは、案としても数える。
    if (c.proposal && c.kind !== 'proposal') counts.proposal += 1
  }
  return counts
}

// 例：「自動改善（11/16）：試用ルールを2件追加、1件を編集。承認待ちの案が1件。」
export function summaryLine(report) {
  const date = new Date(report.at)
  const label = `${date.getMonth() + 1}/${date.getDate()}`
  const counts = report.counts ?? {}
  const parts = COUNT_LABELS.filter(([kind]) => counts[kind]).map(([kind, head, tail]) => `${head}${counts[kind]}${tail}`)
  const sentences = []
  if (parts.length) sentences.push(parts.join('、'))
  if (counts.proposal) sentences.push(`承認待ちの案が${counts.proposal}件`)
  if (counts.draft) sentences.push(`対策を入れなかった記録が${counts.draft}件`)
  if (report.bugs) sentences.push(`バグの候補が${report.bugs}件`)
  if (report.preferences) sentences.push(`確認したい好みの候補が${report.preferences}件`)
  if (!sentences.length) sentences.push('変更なし')
  return `自動改善（${label}）：${sentences.join('。')}。`
}

export const reportHasContent = (report) =>
  Object.values(report.counts ?? {}).some((n) => n > 0) || report.bugs > 0 || report.preferences > 0

// 報告に載せるだけのもの（自動改善の対象外のカテゴリ、見直しの時期が来た試用、再発）。
export function reportExtras(ctx, state = loadAuto(ctx)) {
  const candidates = loadCandidates(ctx)
  const fresh = candidates.filter((c) => c.status === 'new')
  const bugs = fresh.filter((c) => c.category === BUG_CATEGORY)
  const others = fresh.filter((c) => c.category === OTHER_CATEGORY)
  const preferences = summarizeKeys(fresh.filter((c) => c.category === PREFERENCE_CATEGORY), { rejected: state.rejected })
    .filter((e) => e.sessions >= ctx.config.candidates.preference_min_sessions)
  const reviewDays = ctx.config.trial_review_days
  const stale = reviewDays
    ? [
      ...listRules(ctx).map((r) => ({ kind: 'rule', key: r.cause_key, days: daysBetween(r.added_at) })),
      ...listSkills(ctx).map((s) => ({ kind: 'skill', key: s.cause_key, name: s.dir_name, days: daysBetween(s.added_at) })),
    ].filter((t) => t.days >= reviewDays)
    : []
  const recurrences = Object.entries(state.recurrences).map(([key, r]) => ({ key, count: r.count }))
  return { bugs, others, preferences, stale, recurrences }
}

export function writeReport(ctx, lock, body) {
  const state = loadAuto(ctx)
  const mine = state.changes.filter((c) => c.session_id === lock.session_id && !c.report && !c.during_lock)
  const counts = countChanges(mine)
  const extras = reportExtras(ctx, state)
  const day = dayOf(new Date(lock.at))
  let name = `auto-${day}`
  for (let n = 2; existsSync(join(ctx.dirs.reports, `${name}.md`)); n++) name = `auto-${day}-${n}`
  const report = { name, at: lock.at, session_id: lock.session_id, counts, bugs: extras.bugs.length, preferences: extras.preferences.length, closed_at: null }

  const rules = new Map(listRules(ctx).map((r) => [r.cause_key, r]))
  const describe = (c) => {
    if (c.kind === 'trial_add') return `- 試用ルールを追加（${c.cause_key}）：${rules.get(c.cause_key)?.text ?? '（削除済み）'}`
    if (c.kind === 'trial_edit') return `- 試用ルールを編集（${c.cause_key}、再発）：${rules.get(c.cause_key)?.text ?? '（削除済み）'}`
    if (c.kind === 'skill_add') return `- 試用Skillを追加（${c.cause_key}）：${c.ref}`
    if (c.kind === 'draft') return `- 対策を入れなかった記録（${c.cause_key}）：下書きは harness-note pending show ${c.cause_key}`
    return `- 承認待ちの案（${c.cause_key}）：下書きは harness-note pending show ${c.cause_key}`
  }
  const describeTarget = (t) => {
    const note = t.mode === 'recurrence' ? `、再発 ${t.recurrence_no} 回目` : t.blocked ? `、追加できない：${t.blocked}` : ''
    return `- ${t.key}（${t.category}、${t.sessions} セッション${note}）`
  }
  const m = measureAlwaysLoaded(ctx)
  const lines = [
    `# 自動改善の記録（${day}）`, '',
    summaryLine(report), '',
    '## 今回の対象（スクリプトが選んだもの）', '',
    ...(lock.targets.length ? lock.targets.map(describeTarget) : ['- なし']),
    '',
    '## 自動で入れた変更', '',
    ...(mine.length ? mine.map(describe) : ['- なし']),
    '',
    '## 検討の記録', '',
    one(body) || '（記載なし）', '',
    '## 報告だけのもの', '',
    `- バグの候補（${BUG_CATEGORY}）：${extras.bugs.length} 件`,
    ...extras.bugs.map((c) => `  - ${c.id}［${c.cause_key}］${c.text}`),
    `- その他の気づき（${OTHER_CATEGORY}）：${extras.others.length} 件`,
    `- 確認したい好みの候補（${ctx.config.candidates.preference_min_sessions} セッション以上）：${extras.preferences.length} 件`,
    ...extras.preferences.map((p) => `  - ${p.key}（${p.sessions} セッション）：${p.texts.at(-1)}`),
    `- 見直しの時期が来た試用（${ctx.config.trial_review_days} 日超）：${extras.stale.length} 件`,
    ...extras.stale.map((t) => `  - ${t.key}（${t.kind === 'rule' ? '試用ルール' : '試用Skill'}、${t.days} 日）`),
    `- 再発した原因：${extras.recurrences.length} 件`,
    ...extras.recurrences.map((r) => `  - ${r.key}（${r.count} 回）`),
    `- 未確認の自動変更：${unreviewed(state).length} 件（上限 ${ctx.config.auto.max_unreviewed} 件）`,
    `- 常時ロードのルール：${m.rule_lines} 行（目安 ${m.rule_limit} 行）。CLAUDE.md：${m.claude_md} 行（目安 ${m.claude_md_limit} 行）`,
    '',
  ]
  mkdirSync(ctx.dirs.reports, { recursive: true })
  writeFileAtomic(join(ctx.dirs.reports, `${name}.md`), lines.join('\n'))
  updateAuto(ctx, (next) => {
    for (const c of next.changes) if (c.session_id === lock.session_id && !c.report && !c.during_lock) c.report = name
    next.reports = [...next.reports, report].slice(-50)
  })
  // 実行の記録を書いたことを、ロックに残す（unlock は、このあとでだけ受け付ける）。
  updateLock(ctx, lock, (current) => {
    current.report = name
  })
  return { name, file: join(ctx.dirs.reports, `${name}.md`), report }
}

export function readReport(ctx, name) {
  try {
    return readFileSync(join(ctx.dirs.reports, `${safeId(name)}.md`), 'utf8')
  } catch {
    return null
  }
}

// ---- セッション開始時の知らせ ----

// 「人が見た」ことを hook からは知れないので、推定しない。
// 報告の 1 行と 1 回きりの知らせは、review を開くか、明示的に閉じる（harness-note report close）まで、
// または 7 日たつまで、セッション開始時に出し続ける。
export const reportOpen = (report) => !report.closed_at && daysBetween(report.at) < NOTICE_DAYS

export function noticeOpen(state, key) {
  const entry = state.notices[key]
  if (!entry) return true
  return !entry.closed_at && daysBetween(entry.first_shown_at) < NOTICE_DAYS
}

// 初めて出した知らせに、出し始めた時刻を記録する（7 日を数えるため）。
export function recordShown(ctx, keys) {
  const state = loadAuto(ctx)
  const fresh = keys.filter((k) => !state.notices[k])
  const stale = Object.entries(state.notices).some(([, n]) => daysBetween(n.first_shown_at) >= 60)
  if (!fresh.length && !stale) return
  updateAuto(ctx, (next) => {
    for (const key of fresh) next.notices[key] ??= { first_shown_at: iso(), closed_at: null }
    for (const [key, n] of Object.entries(next.notices)) {
      if (daysBetween(n.first_shown_at) >= 60) delete next.notices[key]
    }
  })
}

// 開いている知らせをすべて閉じる（review を開いたとき、または harness-note report close）。
export function closeNotices(ctx) {
  return updateAuto(ctx, (state) => {
    let closed = 0
    for (const report of state.reports) {
      if (!report.closed_at) {
        report.closed_at = iso()
        if (daysBetween(report.at) < NOTICE_DAYS) closed += 1
      }
    }
    for (const notice of Object.values(state.notices)) {
      if (!notice.closed_at) {
        notice.closed_at = iso()
        closed += 1
      }
    }
    return closed
  })
}

// ---- 確認（review）----

// 未確認の自動変更を、中身つきで並べる。
export function reviewItems(ctx) {
  const state = loadAuto(ctx)
  const rules = new Map(listRules(ctx).map((r) => [r.cause_key, r]))
  const skills = listSkills(ctx)
  const items = unreviewed(state).map((c) => {
    const item = { id: c.id, kind: c.kind, cause_key: c.cause_key, at: c.at, days: daysBetween(c.at), report: c.report }
    if (c.during_lock) item.note = '自動改善の実行中に、ロックしたセッション以外から入った変更です。誰が入れたものか、中身とあわせて確かめてください。'
    if (c.kind === 'trial_add' || c.kind === 'trial_edit') {
      const rule = rules.get(c.cause_key)
      item.rule = rule ? { line: renderRule(rule), text: rule.text, edits: rule.edits, previous: rule.history?.at(-1)?.text ?? null } : null
    } else if (c.kind === 'skill_add') {
      const skill = skills.find((s) => s.dir_name === c.ref)
      item.skill = skill ? { name: skill.name, dir: skill.dir, content: readSkill(skill) } : null
    }
    item.proposal = c.kind === 'proposal' || Boolean(c.proposal)
    item.draft = readPending(ctx, c.cause_key)
    return item
  })
  const extras = reportExtras(ctx, state)
  const listed = new Set(items.map((i) => i.cause_key))
  return {
    unreviewed: items,
    // 未確認の変更に結び付いていない下書き（人が retro で作ったものなど）。
    other_drafts: listPending(ctx).filter((key) => !listed.has(key)),
    oldest_days: items.length ? Math.max(...items.map((i) => i.days)) : 0,
    stale_trials: extras.stale,
    bugs: extras.bugs.map((c) => ({ id: c.id, cause_key: c.cause_key, text: c.text, at: c.at })),
    preferences: extras.preferences.map((p) => ({ cause_key: p.key, sessions: p.sessions, texts: p.texts })),
    auto_blocked: ctx.config.auto.interval_days ? blockedReasons(ctx, state) : [],
    next_incident_id: nextIncidentId(ctx.repo.root),
  }
}

export const DECISIONS = ['keep', 'edit', 'remove', 'promote', 'apply', 'dismiss']

// 確認の結果を記録する。remove と dismiss は、その原因を「断られた」とする。
export function reviewDone(ctx, id, decision, { incident = null, path = null } = {}) {
  const state = loadAuto(ctx)
  const change = state.changes.find((c) => c.id === id)
  if (!change) return { ok: false, errors: [`${id} という自動変更はありません。harness-note review で ID を確かめてください`] }
  const key = change.cause_key
  const notes = []
  const dropTrial = () => {
    if (getRule(ctx, key)) {
      removeRule(ctx, key)
      notes.push('試用ルールを消しました')
    }
    for (const skill of listSkills(ctx).filter((s) => s.cause_key === key)) {
      const removed = removeSkill(ctx, skill.name)
      notes.push(removed.ok ? `試用Skill ${skill.dir_name} を消しました` : removed.errors.join(' '))
    }
  }
  if (decision === 'remove' || decision === 'dismiss') {
    if (decision === 'remove') dropTrial()
    if (removePending(ctx, key)) notes.push('失敗票の下書きを捨てました')
    const marked = rejectCause(ctx, key)
    notes.push(`原因 ${key} を「断られた」と記録しました（数えなくなる候補 ${marked} 件）。新しい候補がたまるまで、自動改善の対象にしません`)
  } else if (decision === 'promote') {
    dropTrial()
    if (removePending(ctx, key)) notes.push('失敗票の下書きを捨てました（harness/incidents/ へ移した前提）')
  } else if (incident) {
    // keep / edit / apply：失敗票を harness/incidents/ に置いた前提で、試用ルールの ID を付け替え、下書きを捨てる。
    const rule = getRule(ctx, key)
    if (rule) {
      writeJson(join(ctx.dirs.rules, `${key}.json`), { ...rule, ref: incident })
      notes.push(`試用ルールの失敗票 ID を ${incident} にしました`)
    }
    if (removePending(ctx, key)) notes.push('失敗票の下書きを捨てました（harness/incidents/ へ移した前提）')
  }
  updateAuto(ctx, (next) => {
    // 同じ原因の未確認の変更は、まとめて確認済みにする（remove / promote / dismiss のとき）。
    const together = ['remove', 'promote', 'dismiss'].includes(decision)
    for (const c of next.changes) {
      if (c.reviewed_at) continue
      if (c.id === id || (together && c.cause_key === key)) {
        c.reviewed_at = iso()
        c.decision = decision
      }
    }
    if (decision === 'promote') next.promoted[key] = { at: iso(), path }
  })
  return { ok: true, change, notes }
}

// 採否の集計（設計書 10 章「自動改善の採否」）。
export function decisionStats(state) {
  const kept = state.changes.filter((c) => ['keep', 'edit', 'promote', 'apply'].includes(c.decision)).length
  const removed = state.changes.filter((c) => ['remove', 'dismiss'].includes(c.decision)).length
  return { kept, removed }
}
