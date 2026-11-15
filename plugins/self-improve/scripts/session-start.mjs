// SessionStart の hook。
//   すべての種類（startup / resume / clear / compact / fork）：
//     試用ルールを Claude のコンテキストに読み込ませる（圧縮や再開のあとも読み込み直す）。
//     データの置き場所とセッション ID を、harness-note に引き渡す。
//   startup のときだけ：
//     自動改善の結果、未確認の件数、実行されていない予定、記録が止まっていないかを、ユーザーに知らせる（systemMessage）。
// 「報告済み」の印はここでは付けない。人が最初のプロンプトを送ったあとの、最初の Stop（on-stop.mjs）で付ける。
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  DAY_MS, dayOf, daysBetween, hookContext, isLocked, isMain, iso, listFiles, now, readHookInput, readJson, sessionDir, sha, writeHandoff, writeJson,
} from './lib/core.mjs'
import { pruneCandidates } from './lib/candidates.mjs'
import { validateRuleText } from './lib/content.mjs'
import { computeTargets, intervalState, loadAuto, reportExtras, reportHasContent, summaryLine, unreviewed } from './lib/auto.mjs'
import { listRules, renderRule } from './lib/trial.mjs'
import { pruneEpisodes } from './episode.mjs'
import { runCheck } from './check.mjs'

// hook の出力は 1 つの欄につき 10,000 文字まで。超えるとファイルに逃がされて読まれないので、手前で切る。
const OUTPUT_LIMIT = 9000
const STALLED_DAYS = 7

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

// Bash ツールから実行するコマンドには CLAUDE_PLUGIN_DATA が渡らないので、
// CLAUDE_ENV_FILE（SessionStart で使える）に export を書いて引き渡す。使えないときのために、引き渡しのファイルも残す。
function handOff(ctx) {
  writeHandoff(ctx.data)
  const envFile = process.env.CLAUDE_ENV_FILE
  if (!envFile) return
  const lines = [`export HARNESS_DATA_DIR=${shellQuote(ctx.data)}`, `export HARNESS_SESSION_ID=${shellQuote(ctx.sessionId ?? '')}`]
  let current = ''
  try {
    current = readFileSync(envFile, 'utf8')
  } catch {
    // まだなければ作る
  }
  const lastOf = (name) => current.split('\n').filter((l) => l.startsWith(`export ${name}=`)).at(-1)
  const missing = lines.filter((line) => lastOf(line.slice(7, line.indexOf('='))) !== line)
  if (missing.length) appendFileSync(envFile, `${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`)
}

function trialRuleLines(ctx) {
  const lines = []
  const skipped = []
  for (const rule of listRules(ctx)) {
    // 書き込むときに検査しているが、読み込むときにも確かめる（データ領域を直接書き換えられた場合の備え）。
    if (validateRuleText(rule.text).ok) lines.push(renderRule(rule))
    else skipped.push(rule.cause_key)
  }
  return { lines, skipped }
}

// 記録が止まっていないか。生ログの行数ではなく、記録用の hook が最後に動いた時刻で見る。
// しばらく使っていなかっただけのときに警告しないよう、次の両方を満たすときだけ警告する。
//   - 最後の記録から 7 日以上たっている
//   - 最後の記録より後にセッションが始まっていて、それから 1 日以上、何も記録されていない
function recordingState(previous) {
  const baseline = previous.record ?? previous.first_seen ?? null
  let since = previous.unrecorded_since ?? null
  if (!since || (baseline && since <= baseline)) since = iso()
  const stalled = Boolean(baseline) && daysBetween(baseline) >= STALLED_DAYS && since > baseline && daysBetween(since) >= 1
  return { stalled, unrecorded_since: since }
}

function cleanup(ctx) {
  pruneEpisodes(ctx)
  pruneCandidates(ctx)
  // セッションごとの一時的な状態（依頼文を 1 ターン分だけ持つ）は、2 週間で消す。
  const cutoff = now().getTime() - 14 * DAY_MS
  for (const sid of listFiles(ctx.dirs.sessions)) {
    if (sid === ctx.sessionId) continue
    const dir = join(ctx.dirs.sessions, sid)
    try {
      const latest = Math.max(statSync(dir).mtimeMs, ...listFiles(dir).map((f) => statSync(join(dir, f)).mtimeMs))
      if (latest < cutoff) rmSync(dir, { recursive: true, force: true })
    } catch {
      // 消えていれば何もしない
    }
  }
}

function startupNotices(ctx, recording) {
  const state = loadAuto(ctx)
  const lines = []
  const shown = { reports: [], notices: [] }
  const recently = (key, days) => Boolean(state.notified[key]) && daysBetween(state.notified[key]) < days

  if (ctx.config.error) lines.push(`harness/config.json を読めません（${ctx.config.error}）。初期値で動いています。`)

  // 自動改善の結果。確認するまでは、以降のセッションでも 1 行だけ出す。
  const fresh = state.reports.filter((r) => !r.reported_at && reportHasContent(r)).slice(-3)
  for (const report of fresh) {
    lines.push(`${summaryLine(report)}中身は /self-improve:review で確認できます。`)
    shown.reports.push(report.name)
  }
  // 中身のない記録（変更なし）は、見せずに報告済みにしてよい。
  shown.reports.push(...state.reports.filter((r) => !r.reported_at && !reportHasContent(r)).map((r) => r.name))
  const pending = unreviewed(state)
  const inFresh = pending.filter((c) => shown.reports.includes(c.report)).length
  if (pending.length && (fresh.length === 0 || pending.length > inFresh)) {
    const oldest = Math.max(...pending.map((c) => daysBetween(c.at)))
    lines.push(`未確認の自動変更${pending.length}件。いちばん古いものは${oldest}日前。/self-improve:review で確認できます。`)
  }
  if (pending.length >= ctx.config.auto.max_unreviewed && ctx.config.auto.max_unreviewed > 0) {
    lines.push(`未確認が上限（${ctx.config.auto.max_unreviewed}件）に達しているので、自動改善は新しい追加をやめています。`)
  }

  // 見直しの時期が来た試用（初期値 60 日）。週に 1 回まで。
  const stale = reportExtras(ctx, state).stale
  if (stale.length && !recently('stale_trials', 7)) {
    lines.push(`置いてから${ctx.config.trial_review_days}日を超えた試用が${stale.length}件あります（${stale.map((t) => t.key).join('、')}）。/self-improve:review で「昇格する／残す／消す」を選べます。`)
    shown.notices.push('stale_trials')
  }

  // 自動改善の予定。
  const targets = computeTargets(ctx, state)
  const interval = intervalState(ctx, state)
  if (targets.length && !interval.enabled && !state.notified.enable_auto) {
    lines.push(`自動改善の対象になる原因ができました（${targets.map((t) => t.key).join('、')}）。有効にしますか。有効にするには harness/config.json の auto.interval_days を 7 にします（手順は self-improve の SCHEDULING.md）。`)
    shown.notices.push('enable_auto')
  }
  if (targets.length && interval.enabled && interval.overdue && !recently('auto_overdue', 1)) {
    const last = interval.last_run_at ? `前回は ${dayOf(new Date(interval.last_run_at))}` : 'まだ一度も実行されていません'
    lines.push(`自動改善が、間隔（${ctx.config.auto.interval_days}日）を過ぎても実行されていません（${last}、対象の原因 ${targets.length} 件）。/self-improve:auto-improve を呼べます。`)
    shown.notices.push('auto_overdue')
  }

  if (recording.stalled && !recently('recording_stalled', 1)) {
    lines.push(`記録が止まっているようです（記録用の hook が ${STALLED_DAYS} 日以上動いていません）。/plugin で self-improve が有効か確かめてください。`)
    shown.notices.push('recording_stalled')
  }

  // 整合と行数の警告。同じ内容は、週に 1 回まで。
  const check = runCheck(ctx)
  if (check.warnings.length) {
    const key = `check:${sha(check.warnings.map((w) => w.message).join('\n'), 8)}`
    if (!recently(key, 7)) {
      lines.push(`ハーネスの整合・行数の警告が${check.warnings.length}件あります（例：${check.warnings[0].message}）。作業は止めません。`)
      shown.notices.push(key)
    }
  }
  return { lines, shown }
}

export function sessionStart(input) {
  const ctx = hookContext(input)
  if (!ctx || !ctx.sessionId) return { code: 0 }
  const source = input.source || 'startup'
  const previousHeartbeat = readJson(ctx.dirs.heartbeat, {}) || {}

  handOff(ctx)
  const dir = sessionDir(ctx)
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, 'start.json'), { at: iso(), source })

  const context = []
  const rules = trialRuleLines(ctx)
  if (rules.lines.length) {
    context.push(
      `[self-improve] このリポジトリ（${ctx.repo.name}）の試用ルールです。過去の失敗から作った試用中の決まりなので、この作業でも守ってください。括弧の中は、根拠の失敗票です。`,
      ...rules.lines,
    )
  }

  let notices = []
  // 自動改善のセッションでは、報告を出さない（試用ルールの読み込みだけ行う）。
  if (source === 'startup' && !isLocked(ctx)) {
    try {
      cleanup(ctx)
    } catch {
      // 掃除に失敗しても続ける
    }
    const recording = recordingState(previousHeartbeat)
    const startup = startupNotices(ctx, recording)
    notices = startup.lines
    if (rules.skipped.length) notices.push(`中身の検査を通らない試用ルールがあるので、読み込みませんでした（${rules.skipped.join('、')}）。/self-improve:review で確かめてください。`)
    if (startup.shown.reports.length || startup.shown.notices.length) writeJson(join(dir, 'shown.json'), startup.shown)
    writeJson(ctx.dirs.heartbeat, {
      ...previousHeartbeat,
      first_seen: previousHeartbeat.first_seen ?? iso(),
      session_start: iso(),
      unrecorded_since: recording.unrecorded_since,
    })
  }
  if (notices.length) {
    // ユーザーに見せる内容は、Claude のコンテキストにも渡す（その場で中身を尋ねられるように）。
    context.push(
      ...(context.length ? [''] : []),
      '[self-improve] セッション開始時にユーザーへ表示したお知らせです。詳しくは harness-note report show や harness-note review で読めます。',
      ...notices.map((n) => `- ${n}`),
    )
  }
  if (!context.length && !notices.length) return { code: 0 }

  const cut = (text) => (text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n…（長いので省略しました）` : text)
  const output = {}
  if (context.length) output.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: cut(context.join('\n')) }
  if (notices.length) output.systemMessage = cut(notices.map((n) => `[self-improve] ${n}`).join('\n'))
  return { code: 0, stdout: JSON.stringify(output) }
}

if (isMain(import.meta.url)) {
  try {
    const result = sessionStart(readHookInput())
    if (result.stdout) process.stdout.write(result.stdout)
    process.exitCode = result.code
  } catch (error) {
    process.stderr.write(`[self-improve] session-start で内部エラー：${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}
