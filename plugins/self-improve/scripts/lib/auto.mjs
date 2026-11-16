// 自動改善の状態：ロック、対象の選び方、歯止め、失敗票の下書き、実行の記録、未確認の自動変更、セッション開始時の知らせ。
// 対象の並べ替えと歯止めは、ここで機械的に決める（LLM には選ばせない）。
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUG_CATEGORY, DAY_MS, OTHER_CATEGORY, PREFERENCE_CATEGORY, activeLock, dayOf, daysBetween, isKnownSession, iso, listFiles, now,
  isInside, posix, readJson, realish, safeId, tildePath, withLock, writeFileAtomic, writeJson,
} from './core.mjs'
import { loadCandidates, markCandidates, rankTargets, summarizeKeys } from './candidates.mjs'
import {
  addPersonalRule, getRule, listRules, listSkills, measureAlwaysLoaded, personalRulesFile, promoteSkill, readSkill, removeRule, removeSkill,
  renderRule, ruleCapacity, skillCapacity,
} from './trial.mjs'
import { INCIDENT_ID, getIncident, repoIncidents, updateIncident } from './incidents.mjs'

const EMPTY = { last_run_at: null, changes: [], rejected: {}, recurrences: {}, promoted: {}, reports: [], notices: {}, auto_sessions: {} }
// セッション開始時の知らせ（報告の 1 行と、1 回きりの知らせ）を出し続ける日数。
export const NOTICE_DAYS = 7

// lock を試みたセッションを覚えておく日数。
export const AUTO_SESSION_DAYS = 14

export function loadAuto(ctx) {
  const raw = readJson(ctx.dirs.auto, {}) || {}
  return { ...structuredClone(EMPTY), ...raw }
}

const autoSessionAlive = (at) => {
  const time = Date.parse(at)
  return !Number.isNaN(time) && now().getTime() - time < AUTO_SESSION_DAYS * DAY_MS
}

// 状態ファイルを、排他をかけて書き換える。期限の切れた「lock を試みたセッション」は、書き換えのたびに消す
// （lock が二度と呼ばれないリポジトリでも、残り続けないように）。
export function updateAuto(ctx, fn) {
  return withLock(ctx.dirs.state, () => {
    const state = loadAuto(ctx)
    for (const [id, at] of Object.entries(state.auto_sessions)) {
      if (!autoSessionAlive(at)) delete state.auto_sessions[id]
    }
    const result = fn(state)
    writeJson(ctx.dirs.auto, state)
    return result
  })
}

export const unreviewed = (state) => state.changes.filter((c) => !c.reviewed_at)

// lock を試みたセッション（実行できたかどうかは問わない）。期限は、読み出すときにも確かめる。
export function isAutoSession(ctx, sessionId = ctx.sessionId) {
  if (!sessionId) return false
  const at = loadAuto(ctx).auto_sessions[safeId(sessionId)]
  return Boolean(at) && autoSessionAlive(at)
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
// scope は、止まっている範囲。'all'（試用ルールも試用 Skill も追加しない）か 'rules'（試用ルールだけ追加しない）。
export function blockedState(ctx, state = loadAuto(ctx)) {
  const reasons = []
  const max = ctx.config.auto.max_unreviewed
  const pending = unreviewed(state).length
  const capped = max > 0 && pending >= max
  if (capped) reasons.push(`未確認の自動変更が上限（${max}件）に達している`)
  const rule = ruleCapacity(ctx)
  if (!rule.ok) reasons.push(rule.reason)
  const skill = skillCapacity(ctx)
  if (!rule.ok && !skill.ok) reasons.push(skill.reason)
  const scope = !reasons.length ? null : capped || (!rule.ok && !skill.ok) ? 'all' : 'rules'
  return { reasons, scope }
}
export const blockedReasons = (ctx, state = loadAuto(ctx)) => blockedState(ctx, state).reasons

// ---- ロック ----

// 自動改善のセッションを登録する。間隔がたっていなければ登録せず、何もしないよう伝える。
// 登録を試みたセッションは、成否にかかわらず「自動改善のセッション」として覚えておく
// （ロックが外れたあと・始まらなかったあとも、ガードが書き込みに確認を挟むため）。
export function acquireLock(ctx, sessionId) {
  const sid = safeId(sessionId)
  return updateAuto(ctx, (state) => {
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
  // 下書きは、この実行で作ったものでなければならない。前の実行の下書きが残っていても、
  // 材料（候補と事象メモ）を読み直さずに、試用を足したり編集したりはさせない。
  if (!lock.drafted?.[key] || !existsSync(pendingFile(ctx, key))) {
    return { ok: false, reason: `先に pending add で ${key} の失敗票の下書きを作ってください（前の実行の下書きが残っていても、この実行で作り直します）。` }
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

// ロックしたセッション以外から入った試用ルール（人が retro などで入れたもの）。
// どのセッションが入れたかは、harness-note からは確かめきれない（--session は自己申告）。名乗りの判定に頼らず、
// 誰が入れたものでも、人が review で確認するまで未確認として数える。
// 同じ原因に未確認の変更が既にあれば、足さない（review の「直す」で編集したときに、二重に数えないため）。
export function registerManual(ctx, { kind, key, ref, session, duringLock = false }) {
  return updateAuto(ctx, (state) => {
    const existing = state.changes.find((c) => !c.reviewed_at && c.cause_key === key && CONVERSIONS.includes(c.kind))
    if (existing) return existing
    const created = {
      id: `a-${safeId(key)}-${Date.now().toString(36)}x`, kind, cause_key: key, ref, at: iso(), session_id: session,
      manual: true, during_lock: Boolean(duringLock), report: null, reviewed_at: null, decision: null,
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

const one = (value) => String(value ?? '').replace(/\r\n/g, '\n').trim()

// 下書きを作り、材料にした候補を consumed にする。試用中の原因なら、再発として数える。
// lock は、自動改善のセッションから呼ばれたときのロック（人が呼んだときは null）。
export function addPending(ctx, input, lock = null) {
  const { key, category, signal, rootCause, severity, area, asked, expected, actual, evidence, proposalKind, proposal, by } = input
  const candidates = loadCandidates(ctx).filter((c) => c.cause_key === key && c.status === 'new')
  // 関連する失敗票は、今のリポジトリの票だけを見る。
  const related = repoIncidents(ctx).filter((i) => i.data.cause_key === key).map((i) => i.id)
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
  if (!sentences.length) sentences.push('変更なし')
  return `自動改善（${label}）：${sentences.join('。')}。`
}

export const reportHasContent = (report) =>
  Object.values(report.counts ?? {}).some((n) => n > 0) || report.bugs > 0

// 報告に載せるだけのもの（自動改善の対象外のカテゴリ、見直しの時期が来た試用、再発）。
export function reportExtras(ctx, state = loadAuto(ctx)) {
  const candidates = loadCandidates(ctx)
  const fresh = candidates.filter((c) => c.status === 'new')
  const bugs = fresh.filter((c) => c.category === BUG_CATEGORY)
  const others = fresh.filter((c) => c.category === OTHER_CATEGORY)
  // 好みの候補は user 単位。全リポジトリの分を、異なるセッションの数で数える。
  const preferences = summarizeKeys(fresh.filter((c) => c.category === PREFERENCE_CATEGORY))
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
  const mine = state.changes.filter((c) => c.session_id === lock.session_id && !c.report && !c.during_lock && !c.manual)
  const counts = countChanges(mine)
  const extras = reportExtras(ctx, state)
  const day = dayOf(new Date(lock.at))
  let name = `auto-${day}`
  for (let n = 2; existsSync(join(ctx.dirs.reports, `${name}.md`)); n++) name = `auto-${day}-${n}`
  const report = { name, at: lock.at, session_id: lock.session_id, counts, bugs: extras.bugs.length, closed_at: null }

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
    `- 見直しの時期が来た試用（${ctx.config.trial_review_days} 日超）：${extras.stale.length} 件`,
    ...extras.stale.map((t) => `  - ${t.key}（${t.kind === 'rule' ? '試用ルール' : '試用Skill'}、${t.days} 日）`),
    `- 再発した原因：${extras.recurrences.length} 件`,
    ...extras.recurrences.map((r) => `  - ${r.key}（${r.count} 回）`),
    `- 未確認の自動変更：${unreviewed(state).length} 件（上限 ${ctx.config.auto.max_unreviewed} 件）`,
    `- self-improve が読み込ませるルール：${m.rule_lines} 行（試用ルール ${m.trial_rules} 行＋自分専用のルール ${m.personal_rules} 行、目安 ${m.rule_limit} 行）`,
    '',
  ]
  mkdirSync(ctx.dirs.reports, { recursive: true })
  writeFileAtomic(join(ctx.dirs.reports, `${name}.md`), lines.join('\n'))
  updateAuto(ctx, (next) => {
    for (const c of next.changes) if (c.session_id === lock.session_id && !c.report && !c.during_lock && !c.manual) c.report = name
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

// user 単位の状態（全リポジトリで 1 つ）。リポジトリをまたぐ知らせ（好みの候補、user の設定の注意）と、掃除の日付。
const userStateFile = (ctx) => join(ctx.dirs.userState, 'state.json')
export function loadUserState(ctx) {
  return { notices: {}, cleaned_on: null, ...(readJson(userStateFile(ctx), {}) || {}) }
}
export function updateUserState(ctx, fn) {
  return withLock(ctx.dirs.userState, () => {
    const state = loadUserState(ctx)
    const result = fn(state)
    writeJson(userStateFile(ctx), state)
    return result
  })
}
// user 単位の知らせを初めて出したときに、出し始めた時刻を記録する。
export function recordShownUser(ctx, keys) {
  const state = loadUserState(ctx)
  const fresh = keys.filter((k) => !state.notices[k])
  if (!fresh.length) return
  updateUserState(ctx, (next) => {
    for (const key of fresh) next.notices[key] ??= { first_shown_at: iso(), closed_at: null }
    for (const [key, n] of Object.entries(next.notices)) {
      if (daysBetween(n.first_shown_at) >= 60) delete next.notices[key]
    }
  })
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
  let user = 0
  if (Object.values(loadUserState(ctx).notices).some((n) => !n.closed_at)) {
    user = updateUserState(ctx, (state) => {
      let closed = 0
      for (const notice of Object.values(state.notices)) {
        if (!notice.closed_at) {
          notice.closed_at = iso()
          closed += 1
        }
      }
      return closed
    })
  }
  return user + updateAuto(ctx, (state) => {
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
    else if (c.manual) item.note = '自動改善の実行の外で（harness-note trial add / edit で）入った試用ルールです。入れた覚えがなければ、中身をよく確かめてください。'
    item.manual = Boolean(c.manual)
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
    // 自分専用に昇格済みのもの（参考。確認の対象ではない）。
    promoted: Object.entries(state.promoted).map(([key, p]) => ({ cause_key: key, ...p })),
  }
}

export const DECISIONS = ['keep', 'edit', 'remove', 'apply', 'dismiss']

// 確認の結果を記録する。remove と dismiss は、その原因を「断られた」とする。
// 昇格は、ここではなく promote（harness-note promote）で行う。
export function reviewDone(ctx, id, decision, { incident = null } = {}) {
  const state = loadAuto(ctx)
  const change = state.changes.find((c) => c.id === id)
  if (!change) return { ok: false, errors: [`${id} という自動変更はありません。harness-note review で ID を確かめてください`] }
  const key = change.cause_key
  const notes = []
  if (incident) {
    const found = getIncident(ctx, incident)
    if (!found) return { ok: false, errors: [`失敗票 ${incident} がありません。先に harness-note incident add で起票してください`] }
    if (found.data.repo_id !== ctx.repo.id) return { ok: false, errors: [`失敗票 ${incident} は、別のリポジトリ（${found.data.repo ?? '不明'}）のものです`] }
  }
  if (decision === 'remove' || decision === 'dismiss') {
    if (decision === 'remove') {
      if (getRule(ctx, key)) {
        removeRule(ctx, key)
        notes.push('試用ルールを消しました')
      }
      for (const skill of listSkills(ctx).filter((s) => s.cause_key === key)) {
        const removed = removeSkill(ctx, skill.name)
        notes.push(removed.ok ? `試用Skill ${skill.dir_name} を消しました` : removed.errors.join(' '))
      }
    }
    if (removePending(ctx, key)) notes.push('失敗票の下書きを捨てました')
    const marked = rejectCause(ctx, key)
    notes.push(`原因 ${key} を「断られた」と記録しました（数えなくなる候補 ${marked} 件）。新しい候補がたまるまで、自動改善の対象にしません`)
  } else if (incident) {
    // keep / edit / apply：起票した失敗票の ID を試用ルールに付け、下書きを捨てる。
    const rule = getRule(ctx, key)
    if (rule) {
      writeJson(join(ctx.dirs.rules, `${key}.json`), { ...rule, ref: incident })
      notes.push(`試用ルールの失敗票 ID を ${incident} にしました`)
    }
    if (removePending(ctx, key)) notes.push('失敗票の下書きを捨てました（起票済みのため）')
  }
  updateAuto(ctx, (next) => {
    // 同じ原因の未確認の変更は、まとめて確認済みにする（remove / dismiss のとき）。
    const together = ['remove', 'dismiss'].includes(decision)
    for (const c of next.changes) {
      if (c.reviewed_at) continue
      if (c.id === id || (together && c.cause_key === key)) {
        c.reviewed_at = iso()
        c.decision = decision
      }
    }
  })
  return { ok: true, change, notes }
}

// ---- 昇格 ----

// 試用（ルールか Skill）を昇格する。未確認の変更があってもなくても使える（見直しの時期が来た試用にも）。
//   to: 'personal'  自分専用。ルールは user 側の rules.md に足し（セッション開始時に読み込む）、Skill は置き場所を変えずに
//                   試用の印を外す。リポジトリには何も足さない。
//   to: 'team'      チーム。人の承認を通して、先に .claude/rules/ や .claude/skills/ へ移してあること（path）。
//                   移した先のファイルがあるかを確かめてから、試用を消す。チームへ出すものには、失敗票 ID を付けない
//                   （失敗票は自分の手元にしかなく、ほかの人には引けないため）。
export function promote(ctx, { key, to, path = null, incident = null }) {
  const rule = getRule(ctx, key)
  const skills = listSkills(ctx).filter((s) => s.cause_key === key)
  if (!rule && !skills.length) return { ok: false, errors: [`原因キー ${key} の試用（ルールも Skill も）がありません`] }
  const ref = incident ?? (rule && INCIDENT_ID.test(String(rule.ref)) ? rule.ref : null)
  if (ref) {
    const found = getIncident(ctx, ref)
    if (incident && !found) return { ok: false, errors: [`失敗票 ${incident} がありません。先に harness-note incident add で起票してください`] }
    if (found && found.data.repo_id !== ctx.repo.id) return { ok: false, errors: [`失敗票 ${ref} は、別のリポジトリ（${found.data.repo ?? '不明'}）のものです`] }
  }
  const notes = []
  let control
  if (to === 'personal') {
    if (rule) {
      const added = addPersonalRule(ctx, { text: rule.text, ref })
      if (!added.ok) return { ok: false, errors: added.errors }
      removeRule(ctx, key)
      control = `personal:${tildePath(personalRulesFile(ctx))}`
      notes.push(`自分専用のルールに足しました：${added.line}（${tildePath(added.file)}）。このリポジトリのセッション開始時に読み込みます`)
    }
    for (const skill of skills) {
      const promoted = promoteSkill(ctx, skill.name)
      if (!promoted.ok) return { ok: false, errors: promoted.errors }
      control ??= `personal:${tildePath(promoted.skill.dir)}`
      notes.push(`Skill ${skill.dir_name} を、自分専用にしました（置き場所はそのまま。試用ではなくなり、直接直せます）`)
    }
  } else if (to === 'team') {
    if (!path) return { ok: false, errors: ['チームへ昇格するときは、--path に、移した先のファイル（.claude/rules/… や .claude/skills/…/SKILL.md）を指定してください'] }
    // 移した先があるかを、試用を消す前に確かめる（移し忘れたまま消すと、決まりそのものがなくなる）。
    const target = realish(join(ctx.repo.root, path))
    if (!isInside(ctx.repo.root, target) || target === ctx.repo.root) return { ok: false, errors: ['--path は、このリポジトリの中のファイルにしてください'] }
    let text
    try {
      text = readFileSync(target, 'utf8')
    } catch {
      return { ok: false, errors: [`移した先のファイル（${path}）がありません。先に、ルールや Skill をそこへ書いてください。試用は消していません`] }
    }
    if (!text.trim()) return { ok: false, errors: [`移した先のファイル（${path}）が空です。試用は消していません`] }
    if (/INC-\d{4}-\d{4}/.test(text)) {
      return { ok: false, errors: [`移した先のファイル（${path}）に、失敗票 ID（INC-…）が書かれています。チームへ出すものには付けません（失敗票は、あなたの手元にしかないため）。ID を消してから、やり直してください`] }
    }
    control = posix(path)
    if (rule) {
      removeRule(ctx, key)
      notes.push('試用ルールを消しました')
    }
    for (const skill of skills) {
      const removed = removeSkill(ctx, skill.name)
      if (!removed.ok) return { ok: false, errors: removed.errors }
      notes.push(`試用Skill ${skill.dir_name} を消しました`)
    }
  } else {
    return { ok: false, errors: ['--to は personal（自分専用）か team（チーム）です'] }
  }
  if (ref && getIncident(ctx, ref)) {
    updateIncident(ctx, ref, { status: 'converted', control, promoted_at: dayOf() })
    notes.push(`失敗票 ${ref} を converted にしました`)
    if (removePending(ctx, key)) notes.push('失敗票の下書きを捨てました（起票済みのため）')
  } else if (existsSync(pendingFile(ctx, key))) {
    notes.push(`失敗票の下書きが残っています。記録として残すなら harness-note incident add --from-draft --key ${key}、要らなければ harness-note pending remove ${key}`)
  }
  updateAuto(ctx, (next) => {
    for (const c of next.changes) {
      if (!c.reviewed_at && c.cause_key === key) {
        c.reviewed_at = iso()
        c.decision = 'promote'
      }
    }
    next.promoted[key] = { at: iso(), to, path: control }
  })
  return { ok: true, to, control, notes }
}

// 採否の集計（設計書 10 章「自動改善の採否」）。
export function decisionStats(state) {
  const kept = state.changes.filter((c) => ['keep', 'edit', 'promote', 'apply'].includes(c.decision)).length
  const removed = state.changes.filter((c) => ['remove', 'dismiss'].includes(c.decision)).length
  return { kept, removed }
}
