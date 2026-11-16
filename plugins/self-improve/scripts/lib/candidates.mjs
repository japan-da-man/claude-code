// 改善候補（Claude が書く 1 行の気づき）の保存と集計。
// 1 件 1 ファイル。状態は new / consumed / rejected。件数は「異なるセッションの数」で数える。
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { AUTO_CATEGORIES, DAY_MS, PREFERENCE_CATEGORY, daysBetween, iso, listFiles, now, randomId, readJson, withLock, writeJson } from './core.mjs'

export const KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const TEXT_MAX = 300
// 同じ気づきを続けて書いたときに、二重に数えないための時間。
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000

export function validKey(key) {
  return typeof key === 'string' && key.length >= 3 && key.length <= 50 && KEY_PATTERN.test(key)
}

// 置き場所。好みの候補（behavior/preference）は user 単位で、全リポジトリの分を 1 か所に置く
// （好みはリポジトリをまたぐので、どのリポジトリで書いたものも一緒に数える）。ほかは、リポジトリごと。
const dirOf = (ctx, candidate) => (candidate.category === PREFERENCE_CATEGORY ? ctx.dirs.prefs : ctx.dirs.candidates)

function readDir(dir) {
  const out = []
  for (const file of listFiles(dir, (f) => f.endsWith('.json'))) {
    const c = readJson(join(dir, file))
    if (c && c.id && c.cause_key) out.push(c)
  }
  return out
}

// このリポジトリの候補と、user 単位の好みの候補（全リポジトリの分）。
export function loadCandidates(ctx) {
  const own = readDir(ctx.dirs.candidates).filter((c) => c.category !== PREFERENCE_CATEGORY)
  const prefs = readDir(ctx.dirs.prefs).filter((c) => c.category === PREFERENCE_CATEGORY)
  return [...own, ...prefs].sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

function save(ctx, candidate) {
  const dir = dirOf(ctx, candidate)
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, `${candidate.id}.json`), candidate)
}

const normalize = (text) => String(text).replace(/\s+/g, ' ').trim()

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = current
    }
  }
  return row[b.length]
}

const stem = (token) => token.replace(/(ies|es|s|ing|ed)$/, '')

// 同じ原因に別のキーが付くのを防ぐための、ゆるい照合。
export function isSimilarKey(a, b) {
  if (a === b) return false
  if (a.startsWith(`${b}-`) || b.startsWith(`${a}-`)) return true
  const sa = new Set(a.split('-').map(stem))
  const sb = new Set(b.split('-').map(stem))
  const shared = [...sa].filter((t) => sb.has(t)).length
  if (shared === sa.size && shared === sb.size) return true
  if (shared >= 2 && (shared === sa.size || shared === sb.size)) return true
  return Math.max(a.length, b.length) >= 6 && levenshtein(a, b) <= 2
}

export function similarKeys(key, candidates) {
  const existing = [...new Set(candidates.map((c) => c.cause_key))]
  if (existing.includes(key)) return []
  return existing.filter((other) => isSimilarKey(key, other))
}

// そのセッションが直近 24 時間に記録した件数。「1 セッション 3 件」は、この件数で数える
// （何日も再開して使うセッションが、3 件で記録できなくなるのを防ぐ）。
export function sessionCount(candidates, sessionId) {
  const since = now().getTime() - DAY_MS
  return candidates.filter((c) => c.session_id === sessionId && new Date(c.at).getTime() > since).length
}

// 記録する。記録しなかったときは recorded: false と理由を返す（エラーにはしない）。
// 数えてから書くまでを排他で囲む（並行して呼ばれても、上限を超えて入らないように）。
export function addCandidate(ctx, { category, key, text, sessionId, sessionSource = 'flag', episode = null }) {
  mkdirSync(ctx.dirs.candidates, { recursive: true })
  return withLock(ctx.dirs.candidates, () => {
    const max = ctx.config.candidates.max_per_session
    const all = loadCandidates(ctx)
    const line = normalize(text)
    const at = now()
    const recent = (c) => at.getTime() - new Date(c.at).getTime() < DUPLICATE_WINDOW_MS

    // 同じセッションの同じキー、または同じキー・同じ文面（別のセッションからでも）が続けて来たら、重複。
    const duplicate = all.find((c) => c.cause_key === key && recent(c) && (c.session_id === sessionId || normalize(c.text) === line))
    if (duplicate) return { recorded: false, reason: 'duplicate', duplicate }

    const inSession = sessionCount(all, sessionId)
    if (inSession >= max) return { recorded: false, reason: 'limit', count: inSession, max }

    const candidate = {
      id: randomId('c'),
      category,
      cause_key: key,
      text: line,
      at: iso(at),
      session_id: sessionId,
      session_source: sessionSource,
      episode,
      // どのリポジトリで書いたか（好みの候補は、全リポジトリの分が 1 か所に集まるので、見分けられるように）。
      repo: ctx.repo.name,
      repo_id: ctx.repo.id,
      status: 'new',
    }
    save(ctx, candidate)
    return { recorded: true, candidate, similar: similarKeys(key, all), remaining: max - inSession - 1 }
  })
}

// 原因キーごとの集計。sessions は new の候補を記録した、異なるセッションの数。
export function summarizeKeys(candidates, { rejected = {} } = {}) {
  const byKey = new Map()
  for (const c of candidates) {
    if (!byKey.has(c.cause_key)) byKey.set(c.cause_key, { key: c.cause_key, sessions: new Set(), new: 0, consumed: 0, rejected: 0, categories: {}, latest: null, texts: [] })
    const entry = byKey.get(c.cause_key)
    entry[c.status] = (entry[c.status] ?? 0) + 1
    if (c.status !== 'new') continue
    // 断られた原因は、断られたあとの候補だけを数える。
    const since = rejected[c.cause_key]?.at
    if (since && c.at <= since) continue
    entry.sessions.add(c.session_id)
    entry.categories[c.category] = (entry.categories[c.category] ?? 0) + 1
    if (!entry.latest || c.at > entry.latest) entry.latest = c.at
    entry.texts.push(c.text)
  }
  return [...byKey.values()].map((e) => ({
    ...e,
    sessions: e.sessions.size,
    category: Object.entries(e.categories).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  }))
}

// 自動改善の対象になりうる原因キー。件数の多い順、同数なら新しい順。並べ替えは機械的に行う。
export function rankTargets(candidates, config, { rejected = {} } = {}) {
  const eligible = candidates.filter((c) => AUTO_CATEGORIES.includes(c.category))
  return summarizeKeys(eligible, { rejected })
    .filter((e) => e.sessions >= config.candidates.min_sessions)
    .sort((a, b) => b.sessions - a.sessions || String(b.latest).localeCompare(String(a.latest)))
}

export function markCandidates(ctx, predicate, status, extra = {}) {
  const changed = []
  for (const c of loadCandidates(ctx)) {
    if (!predicate(c) || c.status === status) continue
    const next = { ...c, status, status_at: iso(), ...extra }
    save(ctx, next)
    changed.push(next)
  }
  return changed
}

// 似たキーをまとめ直す（確認のとき）。
export function rekey(ctx, from, to) {
  const changed = []
  for (const c of loadCandidates(ctx)) {
    if (c.cause_key !== from) continue
    const next = { ...c, cause_key: to, rekeyed_from: from }
    save(ctx, next)
    changed.push(next)
  }
  return changed
}

// 保持期間を過ぎた new の候補を、そのディレクトリから消す（1 日 1 回の掃除が、リポジトリごとと user 単位の両方に使う）。
// 1.x が、リポジトリごとの場所に記録した好みの候補を、user 単位の場所へ移す（全リポジトリで数えるため）。
// どのリポジトリで出たか（分かる範囲で）を足す。同じ ID のファイルが移した先にあれば、そのまま残す。
export function adoptLegacyPreferences(fromDir, prefsDir, repo) {
  let moved = 0
  for (const c of readDir(fromDir)) {
    if (c.category !== PREFERENCE_CATEGORY) continue
    const target = join(prefsDir, `${c.id}.json`)
    if (existsSync(target)) continue
    mkdirSync(prefsDir, { recursive: true })
    writeJson(target, { ...c, repo: c.repo ?? repo.name ?? null, repo_id: c.repo_id ?? repo.id })
    rmSync(join(fromDir, `${c.id}.json`), { force: true })
    moved++
  }
  return moved
}

export function pruneCandidatesIn(dir, days) {
  if (!days) return 0
  let removed = 0
  for (const c of readDir(dir)) {
    if (c.status === 'new' && daysBetween(c.at) >= days) {
      rmSync(join(dir, `${c.id}.json`), { force: true })
      removed++
    }
  }
  return removed
}
