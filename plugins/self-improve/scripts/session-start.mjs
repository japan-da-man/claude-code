// SessionStart の hook。init はいらない。除外していない、すべての git リポジトリで動く。
//   すべての種類（startup / resume / clear / compact / fork）：
//     試用ルールと、自分専用に昇格したルールを、Claude のコンテキストに読み込ませる（圧縮や再開のあとも読み込み直す）。
//     データの置き場所・セッション ID・セッションを始めたリポジトリを、harness-note に引き渡す。
//   startup のときだけ：
//     自動改善の結果、未確認の件数、実行されていない予定、重なった好みの候補、記録が止まっていないかを、
//     ユーザーに知らせる（systemMessage）。1 日 1 回、全リポジトリ分の掃除をする。
// 「人が見た」ことを hook からは知れないので、推定しない。報告の 1 行と 1 回きりの知らせは、
// review を開くか、明示的に閉じる（harness-note report close）まで、または 7 日たつまで、出し続ける。
// user の設定（~/.claude/self-improve/config.json）が読めないあいだは、ルールの読み込みと、その知らせだけを行い、
// 記録と掃除はしない。
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  dayOf, daysBetween, hookContext, isLocked, isMain, iso, readHookInput, readJson, sessionDir, sha, tildePath, untrustedVerifyMessage, writeHandoff,
  writeJson,
} from './lib/core.mjs'
import { validKey } from './lib/candidates.mjs'
import { INCIDENT_REF, validateRuleText } from './lib/content.mjs'
import {
  blockedState, computeTargets, intervalState, loadAuto, loadUserState, noticeOpen, recordShown, recordShownUser, reportExtras, reportHasContent,
  reportOpen, summaryLine, unreviewed,
} from './lib/auto.mjs'
import { listPersonalRules, listRules, personalRulesFile, renderRule } from './lib/trial.mjs'
import { cleanupDaily } from './lib/cleanup.mjs'
import { runCheck } from './check.mjs'

// hook の出力は 1 つの欄につき 10,000 文字まで。超えるとファイルに逃がされて読まれないので、手前で切る。
const OUTPUT_LIMIT = 9000
// そのうち、ルール（試用ルールと自分専用のルール）に使う分。残りは、知らせに使う。
const RULES_LIMIT = 6000
const STALLED_DAYS = 7
const CLOSE_HINT = '（閉じるには /self-improve:review を開くか、Claude に「self-improve の知らせを閉じて」と頼みます）'

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`

// Bash ツールから実行するコマンドには CLAUDE_PLUGIN_DATA が渡らないので、
// CLAUDE_ENV_FILE（SessionStart で使える）に export を書いて引き渡す。使えないときのために、引き渡しのファイルも残す。
function handOff(ctx) {
  writeHandoff(ctx.data)
  const envFile = process.env.CLAUDE_ENV_FILE
  if (!envFile) return
  // セッションを始めたリポジトリも引き渡す（Bash のコマンドには CLAUDE_PROJECT_DIR も渡らない。入れ子の別のリポジトリへ
  // cd したあとの harness-note が、hook と同じリポジトリを見るように）。
  const lines = [
    `export HARNESS_DATA_DIR=${shellQuote(ctx.data)}`,
    `export HARNESS_SESSION_ID=${shellQuote(ctx.sessionId ?? '')}`,
    `export HARNESS_PROJECT_DIR=${shellQuote(ctx.repo.root)}`,
  ]
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

// 読み込むルールを決める。試用ルール（データ領域）と、自分専用に昇格したルール（user 側の rules.md）。
// 書き込むときに検査しているが、読み込むときにも確かめる（ファイルを直接書き換えられた場合の備え）。
// 試用ルールは、本文だけでなく、原因キーと失敗票 ID の形も見て、件数は max_trial_rules で切る（新しいものを優先）。
// 文字数の上限（hook の出力の上限）に収まらない分は、読み込まない。読み込まなかったものは、黙って切らずに知らせる。
function ruleLines(ctx) {
  const skipped = []
  const valid = []
  for (const rule of listRules(ctx)) {
    const ok = validKey(rule.cause_key) && (rule.ref === null || rule.ref === undefined || INCIDENT_REF.test(String(rule.ref))) && validateRuleText(rule.text).ok
    if (ok) valid.push(rule)
    else skipped.push(String(rule.cause_key).slice(0, 50).replace(/[^\w-]/g, '?'))
  }
  const max = ctx.config.auto.max_trial_rules
  const newest = [...valid].sort((a, b) => String(b.added_at).localeCompare(String(a.added_at))).slice(0, max)
  const kept = valid.filter((r) => newest.includes(r))
  const trial = kept.map(renderRule)

  const personal = []
  let personalSkipped = 0
  for (const rule of listPersonalRules(ctx)) {
    if (validateRuleText(rule.text).ok) personal.push(`- ${rule.raw}`)
    else personalSkipped += 1
  }

  // 文字数の上限まで入れる。自分専用のルール（人が確認して昇格したもの）を先に、試用ルールは新しいものから。
  let used = 0
  const fits = (line) => {
    if (used + line.length + 1 > RULES_LIMIT) return false
    used += line.length + 1
    return true
  }
  const personalLoaded = personal.filter(fits)
  const trialLoaded = [...trial].reverse().filter(fits).reverse()
  return {
    trial: trialLoaded,
    personal: personalLoaded,
    skipped,
    personalSkipped,
    dropped: valid.length - kept.length,
    overflow: (personal.length - personalLoaded.length) + (trial.length - trialLoaded.length),
  }
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
  return { stalled, baseline, unrecorded_since: since }
}

function startupNotices(ctx, recording) {
  const state = loadAuto(ctx)
  const lines = []
  // 閉じられる知らせ（報告の 1 行と、1 回きりの知らせ）。初めて出した時刻を記録して、7 日を数える。
  const shownKeys = []
  let closable = false
  const once = (key, line) => {
    if (!noticeOpen(state, key)) return
    lines.push(line)
    shownKeys.push(key)
    closable = true
  }
  // user 単位の知らせ（全リポジトリで 1 つ。どのリポジトリで閉じても、ほかのリポジトリでも出なくなる）。
  const userState = loadUserState(ctx)
  const shownUserKeys = []
  const onceUser = (key, line) => {
    if (!noticeOpen(userState, key)) return
    lines.push(line)
    shownUserKeys.push(key)
    closable = true
  }

  // 自動改善の結果。review を開くか、閉じるか、7 日たつまで出す。
  const fresh = state.reports.filter((r) => reportOpen(r) && reportHasContent(r)).slice(-3)
  for (const report of fresh) {
    lines.push(`${summaryLine(report)}中身は /self-improve:review で確認できます。`)
    closable = true
  }
  // 未確認があるあいだは、件数の 1 行を出す（これは閉じても消えない。確認すると消える）。
  const pending = unreviewed(state)
  const inFresh = pending.filter((c) => fresh.some((r) => r.name === c.report)).length
  if (pending.length && (fresh.length === 0 || pending.length > inFresh)) {
    const oldest = Math.max(...pending.map((c) => daysBetween(c.at)))
    // 人が入れた試用ルールも、review で確認するまで数える（誰が入れたかの名乗りには頼らない）。
    const manual = pending.filter((c) => c.manual).length
    lines.push(`未確認の自動変更${pending.length}件${manual ? `（うち、自動改善の実行の外で入った試用ルール${manual}件）` : ''}。いちばん古いものは${oldest}日前。/self-improve:review で確認できます。`)
  }

  // 自動改善の予定。
  const targets = computeTargets(ctx, state)
  const interval = intervalState(ctx, state)
  if (targets.length && !interval.enabled) {
    once('enable_auto', `自動改善の対象になる原因ができました（${targets.map((t) => t.key).join('、')}）。有効にしますか。有効にするには ${tildePath(ctx.config.files.override)} の auto.interval_days を 7 にします（手順は self-improve の SCHEDULING.md）。`)
  }
  if (targets.length && interval.enabled && interval.overdue) {
    const last = interval.last_run_at ? `前回は ${dayOf(new Date(interval.last_run_at))}` : 'まだ一度も実行されていません'
    once(`auto_overdue:${interval.last_run_at ?? 'never'}`, `自動改善が、間隔（${ctx.config.auto.interval_days}日）を過ぎても実行されていません（${last}、対象の原因 ${targets.length} 件）。/self-improve:auto-improve を呼べます。`)
  }
  // 自動改善が追加をやめている理由（有効にしているあいだ、理由が続くかぎり出す）。
  if (interval.enabled) {
    const blocked = blockedState(ctx, state)
    if (blocked.scope) {
      const what = blocked.scope === 'rules' ? '試用ルールを追加していません（試用 Skill は追加できます）' : '試用を追加していません'
      lines.push(`自動改善は、いま${what}：${blocked.reasons.join('。')}。/self-improve:review で確認・昇格するか、ルールを減らすと、また追加します。`)
    }
  }

  // 見直しの時期が来た試用（初期値 60 日）。
  const stale = reportExtras(ctx, state).stale
  if (stale.length) {
    once(`stale_trials:${sha(stale.map((t) => t.key).sort().join(','), 8)}`, `置いてから${ctx.config.trial_review_days}日を超えた試用が${stale.length}件あります（${stale.map((t) => t.key).join('、')}）。/self-improve:review で「昇格する／残す／消す」を選べます。`)
  }

  if (recording.stalled) {
    once(`recording_stalled:${String(recording.baseline).slice(0, 10)}`, `記録が止まっているようです（記録用の hook が ${STALLED_DAYS} 日以上動いていません）。/plugin で self-improve が有効か確かめてください。`)
  }

  // 重なった好みの候補。好みは user 単位なので、知らせも user 単位で 1 つにまとめる（リポジトリごとには出さない）。
  const preferences = reportExtras(ctx, state).preferences
  if (preferences.length) {
    onceUser(`preferences:${sha(preferences.map((p) => p.key).sort().join(','), 8)}`, `重なった好みの候補が${preferences.length}件あります（${preferences.map((p) => p.key).join('、')}）。/self-improve:review で確かめて、合っていれば ~/.claude/CLAUDE.md に足せます。`)
  }

  // 整合と行数の警告。読めないガードの定義は、直すまで毎回知らせる（そのファイルのガードが効いていないため）。
  const check = runCheck(ctx)
  const unreadable = check.warnings.filter((w) => w.rule === 'guards_unreadable')
  for (const w of unreadable) lines.push(`${w.message}。`)
  const others = check.warnings.filter((w) => w.rule !== 'guards_unreadable' && w.rule !== 'config')
  if (others.length) {
    once(`check:${sha(others.map((w) => w.message).join('\n'), 8)}`, `ハーネスの整合・行数の警告が${others.length}件あります（例：${others[0].message}）。作業は止めません。`)
  }
  // 許可されていない検証コマンド（クローンしたばかりのリポジトリ、プルで中身が変わったとき、1.x から上げた直後）。
  // 中身ごとに 1 回きりの知らせにする（閉じるか 7 日で消える。中身が変われば、また出る）。
  if (ctx.config.verify.length && !ctx.config.verify_trust.trusted) {
    once(`verify_untrusted:${ctx.config.verify_trust.hash.slice(0, 12)}`, untrustedVerifyMessage(ctx))
  }
  // 設定の注意（exclude に書いたパスが見つからない、読まない項目がある、など）。
  if (ctx.config.notes.length) {
    onceUser(`config_notes:${sha(ctx.config.notes.join('\n'), 8)}`, `設定の注意：${ctx.config.notes.join('。')}。`)
  }
  if (closable) lines.push(CLOSE_HINT)
  return { lines, shownKeys, shownUserKeys }
}

export function sessionStart(input) {
  const ctx = hookContext(input)
  if (!ctx || !ctx.sessionId) return { code: 0 }
  const source = input.source || 'startup'
  const previousHeartbeat = readJson(ctx.dirs.heartbeat, {}) || {}

  handOff(ctx)
  if (ctx.recording) {
    const dir = sessionDir(ctx)
    mkdirSync(dir, { recursive: true })
    writeJson(join(dir, 'start.json'), { at: iso(), source })
    // どのリポジトリのデータかの控え（掃除が、リポジトリごとの保持期間を引くのに使う）。
    writeJson(ctx.dirs.repoInfo, { root: ctx.repo.root, name: ctx.repo.name, id: ctx.repo.id, seen_at: iso() })
  }

  const context = []
  const rules = ruleLines(ctx)
  if (rules.personal.length) {
    context.push(
      `[self-improve] このリポジトリ（${ctx.repo.name}）で、あなた（ユーザー）が自分専用に決めたルールです。この作業でも守ってください。`,
      ...rules.personal,
    )
  }
  if (rules.trial.length) {
    context.push(
      ...(context.length ? [''] : []),
      `[self-improve] このリポジトリ（${ctx.repo.name}）の試用ルールです。過去の失敗から作った試用中の決まりなので、この作業でも守ってください。括弧の中は、根拠の失敗票です。`,
      ...rules.trial,
    )
  }

  let notices = []
  // 自動改善のセッション（ロック中）では、報告を出さない（ルールの読み込みだけ行う）。
  if (source === 'startup' && !isLocked(ctx)) {
    // 読めない設定は、直すまで毎回知らせる。
    notices.push(...ctx.config.errors.map((e) => `${e}。`))
    if (ctx.recording) {
      try {
        cleanupDaily(ctx)
      } catch {
        // 掃除に失敗しても続ける
      }
      const recording = recordingState(previousHeartbeat)
      const startup = startupNotices(ctx, recording)
      notices.push(...startup.lines)
      if (startup.shownKeys.length) recordShown(ctx, startup.shownKeys)
      if (startup.shownUserKeys.length) recordShownUser(ctx, startup.shownUserKeys)
      writeJson(ctx.dirs.heartbeat, {
        ...previousHeartbeat,
        first_seen: previousHeartbeat.first_seen ?? iso(),
        session_start: iso(),
        unrecorded_since: recording.unrecorded_since,
      })
    }
    // 読み込まなかったルールは、黙って切らずに知らせる。
    if (rules.skipped.length) notices.push(`中身の検査を通らない試用ルールがあるので、読み込みませんでした（${rules.skipped.join('、')}）。/self-improve:review で確かめてください。`)
    if (rules.personalSkipped) notices.push(`自分専用のルール（${tildePath(personalRulesFile(ctx))}）に、中身の検査を通らない行が${rules.personalSkipped}行あるので、読み込みませんでした。`)
    if (rules.dropped) notices.push(`試用ルールが上限（${ctx.config.auto.max_trial_rules}件）を超えているので、新しいものから${ctx.config.auto.max_trial_rules}件だけを読み込みました。`)
    if (rules.overflow) notices.push(`ルールが長く、${rules.overflow}件を読み込みきれませんでした（hook が渡せる量の上限のため）。/self-improve:review で、昇格するか、減らしてください。`)
  }
  if (notices.length) {
    // ユーザーに見せる内容は、Claude のコンテキストにも渡す（その場で中身を尋ねられるように）。
    context.push(
      ...(context.length ? [''] : []),
      '[self-improve] セッション開始時にユーザーへ表示したお知らせです。詳しくは harness-note report show や harness-note review で読めます。ユーザーに「知らせを閉じて」と頼まれたら、harness-note report close を実行します。',
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
