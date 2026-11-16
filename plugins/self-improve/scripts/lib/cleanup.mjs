// 掃除。1 日 1 回、データ領域にある全リポジトリの分をまとめて行う（セッション開始時に呼ばれる）。
// すべてのリポジトリで動くようになったので、セッションを始めるたびに掃除すると無駄が多い。
// また、しばらく開いていないリポジトリの記録も、保持期間で消えるようにする。
import { rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DAY_MS, DEFAULT_CONFIG, USER_SCOPE, dayOf, dirsFor, listFiles, loadConfig, now, readJson } from './core.mjs'
import { readUserConfig } from './scope.mjs'
import { pruneCandidatesIn } from './candidates.mjs'
import { loadUserState, updateUserState } from './auto.mjs'
import { pruneRecords } from '../episode.mjs'

// セッションごとの一時的な状態（依頼文を 1 ターン分だけ持つ）を残す日数。
const SESSION_STATE_DAYS = 14

// そのリポジトリの保持期間。リポジトリの控え（state/<ID>/repo.json）があれば、リポジトリごとの上書きも見る。
function retentionOf(dirs, user) {
  const info = readJson(dirs.repoInfo)
  if (info && typeof info.root === 'string' && typeof info.name === 'string' && typeof info.id === 'string') {
    return loadConfig({ root: info.root, name: info.name, id: info.id }, user).episode_retention_days
  }
  const days = user.raw.episode_retention_days
  return Number.isFinite(days) && days >= 0 ? days : DEFAULT_CONFIG.episode_retention_days
}

function pruneSessions(dirs, keep) {
  const cutoff = now().getTime() - SESSION_STATE_DAYS * DAY_MS
  for (const sid of listFiles(dirs.sessions)) {
    if (sid === keep) continue
    const dir = join(dirs.sessions, sid)
    try {
      const latest = Math.max(statSync(dir).mtimeMs, ...listFiles(dir).map((f) => statSync(join(dir, f)).mtimeMs))
      if (latest < cutoff) rmSync(dir, { recursive: true, force: true })
    } catch {
      // 消えていれば何もしない
    }
  }
}

// 今日まだ掃除していなければ、全リポジトリ分を掃除する。掃除したら true。
export function cleanupDaily(ctx) {
  const today = dayOf()
  if (loadUserState(ctx).cleaned_on === today) return false
  // 先に日付を書く（同時に始まったセッションが、二重に掃除しないように）。
  updateUserState(ctx, (state) => {
    state.cleaned_on = today
  })
  const user = readUserConfig()
  const ids = new Set()
  for (const kind of ['state', 'events', 'episodes', 'candidates']) {
    for (const id of listFiles(join(ctx.data, kind))) if (id !== USER_SCOPE) ids.add(id)
  }
  for (const id of ids) {
    const dirs = dirsFor(ctx.data, id)
    const days = retentionOf(dirs, user)
    pruneRecords(dirs, days)
    pruneCandidatesIn(dirs.candidates, days)
    pruneSessions(dirs, id === ctx.repo.id ? ctx.sessionId : null)
  }
  // user 単位の好みの候補。
  pruneCandidatesIn(ctx.dirs.prefs, retentionOf(dirsFor(ctx.data, USER_SCOPE), user))
  return true
}
