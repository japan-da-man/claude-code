// harness-note：リポジトリの外にあるデータ（改善候補・試用・下書き・実行の記録）を読み書きする、ただ 1 つの窓口。
// 置き場所と中身の検査を、ここに集める。呼び出し側からは、書き込み先のパスを受け取らない。
//
//   harness-note add --category <カテゴリ> --key <原因キー> --text "<1行>" [--session <ID>] [--episode <事象メモID>]
//   harness-note keys | list [--key K] [--category C] [--status new|consumed|rejected|all]
//   harness-note mark <候補ID...> | --key K  --status consumed|rejected
//   harness-note rekey <今のキー> <まとめ先のキー>
//   harness-note episodes <原因キー> | --id <事象メモID> | --recent [N]
//   harness-note trial add|edit --key K --text "<命令形1行>" [--ref INC-YYYY-NNNN]
//   harness-note trial remove --key K [--keep-cause] | trial list
//   harness-note skill add --key K --name N --description "<1行>" --body <本文|-> | --file <SKILL.md|->
//   harness-note skill remove --name N [--keep-cause] | skill list
//   harness-note pending add --key K --root-cause R --asked .. --expected .. --actual .. [--evidence ..] [--proposal-kind guard|verify|edit --proposal ..]
//   harness-note pending list | show <K> | remove <K>
//   harness-note report write --body <本文|-> | report list | report show [名前]
//   harness-note lock --session <ID> | unlock [--session <ID>]
//   harness-note incident add --key K --root-cause R --asked .. --expected .. --actual .. [--evidence ..] [--status S --control C]
//   harness-note incident add --from-draft --key K     下書きから起票する（下書きの値を引き継ぐ）
//   harness-note incident list [--all] | show <ID> | set <ID> --status S [--control C] | import
//   harness-note promote --key K --to personal|team [--path <移した先>] [--incident INC-..]
//   harness-note verify [show] | verify trust     リポジトリの検証コマンド（harness/config.json の verify）の一覧と、実行の許可
//   harness-note targets | status | review | review done <変更ID> --decision keep|edit|remove|apply|dismiss [--incident INC-..]
//
//   harness-note report close            セッション開始時の知らせ（報告の 1 行など）を閉じる
//
// 読み出し系には --json を付けられる。方針で記録・追加しなかったときは、終了コード 0 で理由を返す。
// セッション ID は --session で受け取る。hook が引き渡した環境変数（HARNESS_SESSION_ID）と食い違えば、受け付けない。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  activeLock, dayOf, daysBetween, inactiveReason, iso, isKnownSession, isLocked, listFiles, makeContext, parseFrontmatter, readStdin,
  recordVerifyTrust, safeId, sessionLock, tildePath, verifyTrustFile,
} from './lib/core.mjs'
import { UsageError, parseArgs } from './lib/args.mjs'
import { TEXT_MAX, addCandidate, loadCandidates, markCandidates, rekey, summarizeKeys, validKey } from './lib/candidates.mjs'
import { INCIDENT_ID, INCIDENT_STATUSES, addIncident, getIncident, importIncidents, listIncidents, repoIncidents, updateIncident } from './lib/incidents.mjs'
import { guardFiles } from './lib/guard.mjs'
import {
  addRule, addSkill, editRule, listRules, listSkills, measureAlwaysLoaded, parseSkillMarkdown, readSkill, removeRule,
  removeSkill, renderRule, ruleCapacity,
} from './lib/trial.mjs'
import {
  DECISIONS, PROPOSAL_KINDS, ROOT_CAUSES, SIGNALS, acquireLock, addPending, autoGate, blockedReasons, closeNotices, computeTargets,
  decisionStats, intervalState, isAutoSession, listPending, loadAuto, markPendingTrial, readPending, readReport, registerChange,
  promote, registerManual, rejectCause, releaseLock, removePending, reviewDone, reviewItems, summaryLine, unreviewed, updateAuto, writeReport,
} from './lib/auto.mjs'

let stdinCache = null
const stdin = () => (stdinCache ??= readStdin())

function makeReader(flags, allowed) {
  const unknown = Object.keys(flags).filter((f) => !allowed.includes(f) && f !== 'json' && f !== 'session')
  if (unknown.length) {
    throw new UsageError(`使えないオプションです：${unknown.map((f) => `--${f}`).join('、')}（使えるのは ${allowed.map((f) => `--${f}`).join('、') || 'なし'}）`)
  }
  const one = (name) => {
    const values = flags[name]
    if (!values) return null
    const value = values.at(-1)
    return value === true ? true : String(value)
  }
  // 複数行の値。「-」は標準入力、文字どおりの \n は改行として読む。--body を重ねれば行を足せる。
  const text = (name) => {
    const values = flags[name]
    if (!values) return null
    return values.map((v) => (v === '-' ? stdin() : String(v).replace(/\\n/g, '\n'))).join('\n')
  }
  const required = (name, read = one) => {
    const value = read(name)
    if (value === null || value === true || !String(value).trim()) throw new UsageError(`--${name} が必要です`)
    return value
  }
  return { one, text, required, has: (name) => Boolean(flags[name]) }
}

// セッション ID を決める。--session → hook が引き渡した環境変数 → 直近のセッションからの推定、の順。
// --session は自己申告なので、hook が引き渡した ID（HARNESS_SESSION_ID）と食い違うときは受け付けない。
// （Bash のコマンドを見る側のガードも、hook の本物の session_id と照らしている。）
function resolveSession(ctx, flags) {
  const handed = process.env.HARNESS_SESSION_ID ? safeId(process.env.HARNESS_SESSION_ID) : null
  const given = (flags.session ?? []).filter((v) => v !== true).map((v) => safeId(v))
  if (new Set(given).size > 1) throw new UsageError('--session が複数あり、値が食い違っています')
  if (given.length) {
    if (handed && handed !== given[0]) {
      throw new UsageError('--session が、このセッションの ID と食い違っています。ほかのセッションを名乗ることはできません')
    }
    return { id: given[0], source: 'flag' }
  }
  if (handed) return { id: handed, source: 'env' }
  if (process.env.CLAUDE_CODE_SESSION_ID) return { id: safeId(process.env.CLAUDE_CODE_SESSION_ID), source: 'env' }
  // 環境変数が渡らないときは、このリポジトリで直近に動いていたセッションと見なす（推定）。
  const cutoff = Date.now() - 12 * 60 * 60 * 1000
  let best = null
  for (const sid of listFiles(ctx.dirs.sessions)) {
    let latest = 0
    for (const file of listFiles(join(ctx.dirs.sessions, sid))) {
      try {
        latest = Math.max(latest, statSync(join(ctx.dirs.sessions, sid, file)).mtimeMs)
      } catch {
        // 消えたファイルは数えない
      }
    }
    if (latest >= cutoff && (!best || latest > best.latest)) best = { sid, latest }
  }
  if (best) return { id: best.sid, source: 'recent' }
  return { id: `unknown-${dayOf()}`, source: 'unknown' }
}

const estimated = (session) => session.source === 'recent' || session.source === 'unknown'

// 書き込み系のコマンドが、どのセッションから呼ばれたかを決める。
//   - ロックのファイルを読めないときは、受け付けない（拒否の側に倒す）
//   - 自動改善が実行中なのにセッションを確かめられないときは、受け付けない
//     （自動改善のセッションからの書き込みが、人の書き込みとして歯止めをすり抜けるのを防ぐ）
//   - 別のリポジトリのロックを持っているセッション（自動改善の途中で別のリポジトリへ移った）からは、受け付けない
function writerSession(ctx, flags) {
  const session = resolveSession(ctx, flags)
  const lock = activeLock(ctx)
  if (lock?.broken) throw new UsageError('ロックのファイル（lock.json）を読めません。2 時間たつか、人が確かめるまで、書き込みは受け付けません')
  if (lock && estimated(session)) {
    throw new UsageError('自動改善が実行中です。どのセッションからの書き込みかを確かめるので、--session <セッションID> を付けて呼んでください')
  }
  const elsewhere = sessionLock(ctx.data, session.id)
  if (elsewhere && elsewhere.repoId !== ctx.repo.id) {
    throw new UsageError('このセッションは、別のリポジトリで自動改善を実行中です。このリポジトリには書き込めません')
  }
  return { session, lock, locked: Boolean(lock && lock.session_id === session.id) }
}

// 人だけの操作（試用の追加・編集・削除、候補の採否、下書きの破棄、確認の結果、知らせを閉じる）を、
// 受け付けない理由。受け付けてよければ null。
//   - 自動改善のセッション（ロック中）
//   - lock を試みたセッション（ロックが外れたあと・始まらなかったあとも。同じセッションが「人」として書き込むのを防ぐ）
//   - 自動改善の実行中（ロックしたセッション以外からでも。名乗りを確かめきれないため、終わるまで待ってもらう）
function humanOnlyRefusal(ctx, writer) {
  if (writer.locked) return HUMAN_ONLY
  if (isAutoSession(ctx, writer.session.id)) return AFTER_AUTO
  if (writer.lock) return DURING_LOCK
  return null
}

const out = (text) => process.stdout.write(`${text}\n`)
const json = (value) => out(JSON.stringify(value, null, 2))
const short = (id) => String(id ?? '').slice(0, 8)

function refuse(lines) {
  out(Array.isArray(lines) ? lines.join('\n') : lines)
  return 0
}
function fail(errors) {
  process.stderr.write(`${(Array.isArray(errors) ? errors : [errors]).map((e) => `harness-note: ${e}`).join('\n')}\n`)
  return 1
}

// 候補の状態の変更、キーのまとめ直し、下書きの破棄は、人が確認して行うもの。
const HUMAN_ONLY = '見送り：自動改善のセッションでは、この操作は行いません。必要なら、報告に書いてください。'
const AFTER_AUTO = '見送り：このセッションは、自動改善（auto-improve）を呼び出したセッションです。ロックが外れたあと・始まらなかったあとも、この操作は行いません。人が、新しいセッションで行ってください。'
const NEEDS_SESSION = '見送り：どのセッションからの操作かを確かめられないので、知らせは閉じません。harness-note report close --session <セッションID> の形で呼んでください。'
const DURING_LOCK = '見送り：自動改善が実行中です。この操作は、実行が終わってから（ロックが外れてから）行ってください。'

function requireKey(key) {
  if (!validKey(key)) throw new UsageError(`原因キーは英小文字・数字をハイフンでつないだ 3〜50 文字にしてください（例：route-placement）：${key}`)
  return key
}

// ---- 改善候補 ----

function cmdAdd(ctx, flags) {
  const r = makeReader(flags, ['category', 'key', 'text', 'episode'])
  const session = resolveSession(ctx, flags)
  if (isLocked(ctx, session.id)) {
    return refuse('自動改善のセッションなので、改善候補は記録しません。何もせず終了してよい。')
  }
  if (activeLock(ctx) && estimated(session)) {
    return refuse('記録しません：自動改善が実行中で、どのセッションからの記録かを確かめられません。--session <セッションID> を付けてください。付けられなければ、何もせず終了してよい。')
  }
  // user の設定が読めないあいだは、記録を止めている（除外の一覧を信じられないため）。
  if (!ctx.recording) {
    return refuse('記録しません：~/.claude/self-improve/config.json を読めないので、記録を止めています。そのまま終了してよい。')
  }
  const category = r.required('category')
  const categories = ctx.config.candidates.categories
  if (!categories.includes(category)) throw new UsageError(`カテゴリは次のどれかにしてください：${categories.join('、')}`)
  const key = requireKey(r.required('key'))
  const text = r.required('text')
  if (/[\r\n]/.test(text.trim())) throw new UsageError('--text は 1 行で書いてください')
  if (text.trim().length > TEXT_MAX) throw new UsageError(`--text は ${TEXT_MAX} 文字までです`)
  // 件数は「異なるセッションの数」で数えるので、hook が記録しているセッションの ID だけを受け付ける
  // （1 つのセッションが、ありもしない ID を名乗って件数を重ねるのを防ぐ。lock と同じ前提）。
  if (!isKnownSession(ctx, session.id)) {
    return refuse(`記録しません：セッション ${session.id} は、このプラグインの hook に記録されていません。ターン終了時の確認に書かれている --session の値を、そのまま使ってください。使えなければ、何もせず終了してよい。`)
  }
  let episode = r.one('episode')
  const notes = []
  if (episode && !existsSync(join(ctx.dirs.episodes, `${safeId(episode)}.md`))) {
    notes.push(`事象メモ ${episode} が見つからないので、参照は付けません。`)
    episode = null
  }
  const result = addCandidate(ctx, { category, key, text, sessionId: session.id, sessionSource: session.source, episode: episode ? safeId(episode) : null })
  if (!result.recorded) {
    if (result.reason === 'duplicate') {
      return refuse(`記録しません：同じ原因キー（${key}）の候補を、少し前に記録済みです（${result.duplicate.id}）。二重には数えません。そのまま終了してよい。`)
    }
    return refuse(`記録しません：このセッションの上限（${result.max} 件）に達しています。これ以上は記録せず、そのまま終了してください。`)
  }
  const lines = [`記録しました：${result.candidate.id}［${category}］${key}（このセッションではあと ${Math.max(0, result.remaining)} 件）`, ...notes]
  if (result.similar.length) {
    lines.push(
      `警告：似た原因キーが既にあります：${result.similar.join('、')}`,
      `同じ原因なら、次でまとめ直してください：harness-note rekey ${key} ${result.similar[0]}`,
    )
  }
  if (estimated(session)) {
    lines.push('注意：セッション ID を受け取れなかったので、直近のセッションと見なして記録しました。次からは --session を付けてください。')
  }
  out(lines.join('\n'))
  return 0
}

function keyRows(ctx) {
  const state = loadAuto(ctx)
  const rules = new Set(listRules(ctx).map((r) => r.cause_key))
  const skills = new Set(listSkills(ctx).map((s) => s.cause_key))
  return summarizeKeys(loadCandidates(ctx), { rejected: state.rejected })
    .map((e) => ({
      key: e.key,
      sessions: e.sessions,
      new: e.new,
      consumed: e.consumed,
      rejected: e.rejected,
      category: e.category,
      latest: e.latest,
      trial: rules.has(e.key) ? 'rule' : skills.has(e.key) ? 'skill' : state.promoted[e.key] ? 'promoted' : null,
      rejected_at: state.rejected[e.key]?.at ?? null,
    }))
    .sort((a, b) => b.sessions - a.sessions || String(b.latest).localeCompare(String(a.latest)))
}

function cmdKeys(ctx, flags) {
  makeReader(flags, [])
  const rows = keyRows(ctx)
  if (flags.json) return json(rows), 0
  if (!rows.length) return out('原因キーはまだありません。'), 0
  out('原因キー（セッション数は、new の候補を記録した異なるセッションの数）')
  for (const r of rows) {
    const marks = [r.trial ? `試用中:${r.trial}` : null, r.rejected_at ? `断られた:${r.rejected_at.slice(0, 10)}` : null].filter(Boolean).join(' ')
    out(`- ${r.key}  セッション ${r.sessions}  new ${r.new} / consumed ${r.consumed} / rejected ${r.rejected}  ${r.category ?? '-'}  ${marks}`.trimEnd())
  }
  return 0
}

function cmdList(ctx, flags) {
  const r = makeReader(flags, ['key', 'category', 'status'])
  const status = r.one('status') ?? 'new'
  const rows = loadCandidates(ctx).filter((c) =>
    (status === 'all' || c.status === status) && (!r.one('key') || c.cause_key === r.one('key')) && (!r.one('category') || c.category === r.one('category')))
  if (flags.json) return json(rows), 0
  if (!rows.length) return out('該当する改善候補はありません。'), 0
  for (const c of rows) {
    out(`- ${c.id}［${c.status}］${c.category}  ${c.cause_key}（${c.at.slice(0, 10)}、セッション ${short(c.session_id)}${c.episode ? `、事象メモ ${c.episode}` : ''}）${c.text}`)
  }
  return 0
}

function cmdMark(ctx, positional, flags) {
  const r = makeReader(flags, ['key', 'status'])
  const refusal = humanOnlyRefusal(ctx, writerSession(ctx, flags))
  if (refusal) return refuse(refusal)
  const status = r.required('status')
  if (!['consumed', 'rejected'].includes(status)) throw new UsageError('--status は consumed か rejected です')
  const key = r.one('key')
  if (key) {
    if (status === 'rejected') {
      const n = rejectCause(ctx, requireKey(key))
      out(`原因 ${key} を「断られた」と記録しました（数えなくなる候補 ${n} 件）。`)
    } else {
      const n = markCandidates(ctx, (c) => c.cause_key === key && c.status === 'new', 'consumed', { consumed_by: 'human' }).length
      out(`原因 ${key} の候補 ${n} 件を consumed にしました。`)
    }
    return 0
  }
  if (!positional.length) throw new UsageError('候補の ID か --key が必要です')
  const ids = new Set(positional)
  const changed = markCandidates(ctx, (c) => ids.has(c.id), status, status === 'consumed' ? { consumed_by: 'human' } : {})
  out(`${changed.length} 件を ${status} にしました。`)
  return 0
}

function cmdRekey(ctx, positional, flags) {
  makeReader(flags, [])
  const refusal = humanOnlyRefusal(ctx, writerSession(ctx, flags))
  if (refusal) return refuse(refusal)
  const [from, to] = positional
  if (!from || !to) throw new UsageError('使い方：harness-note rekey <今のキー> <まとめ先のキー>')
  requireKey(to)
  const changed = rekey(ctx, from, to)
  out(`${changed.length} 件の候補を ${from} から ${to} にまとめ直しました。`)
  return 0
}

function cmdEpisodes(ctx, positional, flags) {
  const r = makeReader(flags, ['id', 'recent'])
  let ids = []
  if (r.one('id')) ids = [safeId(r.one('id'))]
  else if (r.has('recent')) {
    const n = Number(r.one('recent')) || 5
    ids = listFiles(ctx.dirs.episodes, (f) => f.endsWith('.md')).slice(-n).map((f) => f.replace(/\.md$/, ''))
  } else {
    const key = positional[0]
    if (!key) throw new UsageError('使い方：harness-note episodes <原因キー>（または --id <事象メモID>、--recent [N]）')
    ids = [...new Set(loadCandidates(ctx).filter((c) => c.cause_key === key && c.episode).map((c) => c.episode))]
  }
  const found = ids.map((id) => {
    try {
      return { id, text: readFileSync(join(ctx.dirs.episodes, `${id}.md`), 'utf8') }
    } catch {
      return { id, text: null }
    }
  })
  if (flags.json) return json(found), 0
  if (!found.length) return out('該当する事象メモはありません（候補だけが証拠です。未検証の主張として扱ってください）。'), 0
  for (const e of found) out(e.text === null ? `# ${e.id}\n（保持期間を過ぎて消えたか、見つかりません）\n` : `${e.text}\n`)
  return 0
}

// ---- 試用ルール ----


function cmdTrial(ctx, positional, flags) {
  const sub = positional[0]

  if (sub === 'list') {
    makeReader(flags, [])
    const rules = listRules(ctx).map((rule) => ({ ...rule, line: renderRule(rule), days: daysBetween(rule.added_at) }))
    if (flags.json) return json(rules), 0
    if (!rules.length) return out('試用ルールはありません。'), 0
    for (const rule of rules) out(`${rule.line}  ［${rule.cause_key}、${rule.by}、${rule.days} 日、編集 ${rule.edits} 回］`)
    return 0
  }
  const writer = writerSession(ctx, flags)
  const { session, lock, locked } = writer
  // ロックしたセッション以外からの追加・編集・削除は、人の操作。lock を試みたセッションと、自動改善の実行中は受け付けない
  // （対象の限定・下書きが先・未確認の登録が効かないまま、試用が入るのを防ぐ）。
  if (!locked && ['add', 'edit', 'remove'].includes(sub)) {
    const refusal = humanOnlyRefusal(ctx, writer)
    if (refusal) return refuse(refusal)
  }

  if (sub === 'add' || sub === 'edit') {
    const r = makeReader(flags, ['key', 'text', 'ref'])
    const key = requireKey(r.required('key'))
    const ref = r.one('ref')
    if (ref && !INCIDENT_ID.test(ref)) throw new UsageError('--ref は失敗票の ID（INC-YYYY-NNNN）です')
    const text = sub === 'add' ? r.required('text') : r.one('text')
    if (sub === 'edit' && text === null && !ref) throw new UsageError('--text か --ref が必要です')
    const op = `trial ${sub}`
    const by = locked ? 'auto' : 'human'
    const notes = []
    if (locked) {
      const gate = autoGate(ctx, lock, op, key)
      if (!gate.ok) return refuse(`見送り：${gate.reason}`)
    } else if (sub === 'add') {
      const max = ctx.config.auto.max_trial_rules
      if (listRules(ctx).length >= max) {
        return refuse(`見送り：試用ルールが上限（${max} 件）に達しています。先に /self-improve:review で昇格するか消してください。`)
      }
      const capacity = ruleCapacity(ctx)
      if (!capacity.ok) notes.push(`警告：${capacity.reason}。人が入れる分は止めませんが、/self-improve:review で、チームへ昇格するか、減らすことを検討してください。`)
    }
    const result = sub === 'add'
      ? addRule(ctx, { key, text, ref: ref ?? null, by })
      : editRule(ctx, { key, text, ref: ref ?? undefined, by })
    if (!result.ok) return fail(result.errors)
    const kind = sub === 'add' ? 'trial_add' : 'trial_edit'
    if (locked) {
      registerChange(ctx, lock, { kind, key, ref: key })
      if (sub === 'add') markPendingTrial(ctx, key, `trial:rules/${key}`)
    } else if (text !== null) {
      // ロックしたセッション以外から入った試用。どのセッションが入れたかは確かめきれないので、名乗りにかかわらず、
      // 人が review で確認するまで未確認として数える。
      const change = registerManual(ctx, { kind, key, ref: key, session: session.id })
      notes.push(`人が /self-improve:review で確認するまで、未確認として数えます（変更 ID：${change.id}）。`)
    }
    out([`試用ルールを${sub === 'add' ? '追加' : '更新'}しました：${renderRule(result.rule)}`, '次のセッション開始時から読み込まれます。', ...notes].join('\n'))
    return 0
  }

  if (sub === 'remove') {
    const r = makeReader(flags, ['key', 'keep-cause'])
    const key = requireKey(r.required('key'))
    if (locked) return refuse('見送り：自動改善のセッションでは、試用を消しません。消す案は報告に書いてください。')
    const result = removeRule(ctx, key)
    if (!result.ok) return fail(result.errors)
    return finishRemoval(ctx, key, r.has('keep-cause'), `試用ルールを消しました：${renderRule(result.rule)}`)
  }
  throw new UsageError('使い方：harness-note trial add|edit|remove|list')
}

// 試用を消したあとの始末。未確認の変更を確認済みにし、（既定では）その原因を「断られた」とする。
function finishRemoval(ctx, key, keepCause, message) {
  const lines = [message]
  updateAuto(ctx, (state) => {
    for (const c of state.changes) {
      if (!c.reviewed_at && c.cause_key === key) {
        c.reviewed_at = iso()
        c.decision = 'remove'
      }
    }
  })
  if (!keepCause) {
    const n = rejectCause(ctx, key)
    lines.push(`原因 ${key} を「断られた」と記録しました（数えなくなる候補 ${n} 件）。新しい候補がたまるまで、自動改善の対象にしません。`)
  }
  out(lines.join('\n'))
  return 0
}

// ---- 試用 Skill ----

function cmdSkill(ctx, positional, flags) {
  const sub = positional[0]

  if (sub === 'list') {
    makeReader(flags, [])
    const skills = listSkills(ctx).map((s) => ({ ...s, days: daysBetween(s.added_at) }))
    if (flags.json) return json(skills.map((s) => ({ ...s, content: readSkill(s) }))), 0
    if (!skills.length) return out('試用 Skill はありません。'), 0
    for (const s of skills) out(`- ${s.dir_name}  ［${s.cause_key}、${s.days} 日］ ${s.dir}`)
    return 0
  }
  const writer = writerSession(ctx, flags)
  const { lock, locked } = writer

  if (sub === 'add') {
    // 受け取るのは name・description・本文だけ。allowed-tools や hooks などを渡す口は作らない。
    const r = makeReader(flags, ['key', 'name', 'description', 'body', 'file'])
    const key = requireKey(r.required('key'))
    if (!locked) {
      return refuse('見送り：試用 Skill を置けるのは、自動改善のセッションだけです。人が始める振り返りでは、Skill は、自分専用なら ~/.claude/skills/ に、チームで使うならリポジトリの .claude/skills/ に、差分の承認を通して置いてください。')
    }
    let input
    if (r.has('file')) {
      const source = r.one('file')
      let text
      try {
        text = source === '-' ? stdin() : readFileSync(source, 'utf8')
      } catch (e) {
        return fail(`--file を読めません：${e.message}`)
      }
      const parsed = parseSkillMarkdown(text)
      input = {
        name: r.one('name') ?? parsed.name,
        description: r.one('description') ?? parsed.description,
        body: parsed.body,
        frontmatterKeys: parsed.frontmatterKeys,
      }
    } else {
      input = { name: r.required('name'), description: r.required('description'), body: r.required('body', r.text), frontmatterKeys: [] }
    }
    // SKILL.md の name には <リポジトリ名>-<名前> が入っていることがあるので、前置きは外して受け取る。
    const prefix = `${ctx.repo.name}-`
    if (typeof input.name === 'string' && input.name.startsWith(prefix)) input.name = input.name.slice(prefix.length)
    const gate = autoGate(ctx, lock, 'skill add', key)
    if (!gate.ok) return refuse(`見送り：${gate.reason}`)
    const result = addSkill(ctx, { key, ...input, by: 'auto' })
    if (!result.ok) return fail(result.errors)
    registerChange(ctx, lock, { kind: 'skill_add', key, ref: result.skill.dir_name })
    markPendingTrial(ctx, key, `skill:${result.skill.dir_name}`)
    out(`試用 Skill を追加しました：${result.skill.dir}/SKILL.md`)
    return 0
  }

  if (sub === 'remove') {
    const r = makeReader(flags, ['name', 'keep-cause'])
    if (locked) return refuse('見送り：自動改善のセッションでは、試用を消しません。消す案は報告に書いてください。')
    const refusal = humanOnlyRefusal(ctx, writer)
    if (refusal) return refuse(refusal)
    let name = r.required('name')
    const prefix = `${ctx.repo.name}-`
    if (name.startsWith(prefix)) name = name.slice(prefix.length)
    const result = removeSkill(ctx, name)
    if (!result.ok) return fail(result.errors)
    return finishRemoval(ctx, result.skill.cause_key, r.has('keep-cause'), `試用 Skill を消しました：${result.skill.dir}`)
  }
  throw new UsageError('使い方：harness-note skill add|remove|list')
}

// ---- 失敗票の下書き ----

function cmdPending(ctx, positional, flags) {
  const sub = positional[0]
  if (sub === 'list') {
    makeReader(flags, [])
    const keys = listPending(ctx)
    if (flags.json) return json(keys), 0
    out(keys.length ? keys.map((k) => `- ${k}`).join('\n') : '失敗票の下書きはありません。')
    return 0
  }
  if (sub === 'show' || sub === 'remove') {
    makeReader(flags, [])
    const key = positional[1]
    if (!key) throw new UsageError(`使い方：harness-note pending ${sub} <原因キー>`)
    if (sub === 'show') {
      const text = readPending(ctx, key)
      if (text === null) return fail(`${key} の下書きはありません`)
      out(text)
      return 0
    }
    const refusal = humanOnlyRefusal(ctx, writerSession(ctx, flags))
    if (refusal) return refuse(refusal)
    out(removePending(ctx, key) ? `${key} の下書きを捨てました。` : `${key} の下書きはありません。`)
    return 0
  }
  if (sub !== 'add') throw new UsageError('使い方：harness-note pending add|list|show|remove')

  const r = makeReader(flags, ['key', 'category', 'signal', 'root-cause', 'severity', 'area', 'asked', 'expected', 'actual', 'evidence', 'proposal-kind', 'proposal'])
  const key = requireKey(r.required('key'))
  const { lock, locked } = writerSession(ctx, flags)
  const rootCause = r.required('root-cause')
  if (!ROOT_CAUSES.includes(rootCause)) throw new UsageError(`--root-cause は次のどれかです：${ROOT_CAUSES.join('、')}`)
  const signal = r.one('signal') ?? 'noticed'
  if (!SIGNALS.includes(signal)) throw new UsageError(`--signal は次のどれかです：${SIGNALS.join('、')}`)
  const severity = r.one('severity') ?? 'normal'
  if (!['normal', 'high'].includes(severity)) throw new UsageError('--severity は normal か high です')
  const proposalKind = r.one('proposal-kind')
  if (proposalKind && !PROPOSAL_KINDS.includes(proposalKind)) throw new UsageError(`--proposal-kind は次のどれかです：${PROPOSAL_KINDS.join('、')}`)
  if (proposalKind && !r.has('proposal')) throw new UsageError('--proposal-kind には --proposal（案の中身）が必要です')
  const area = r.one('area')
  if (area && !/^[A-Za-z0-9_./-]{1,40}$/.test(area)) throw new UsageError('--area は英数字の短い名前にしてください')

  let category = r.one('category')
  if (locked) {
    const gate = autoGate(ctx, lock, 'pending add', key, { proposal: Boolean(proposalKind), rootCause })
    if (!gate.ok) return refuse(`見送り：${gate.reason}`)
    category ??= gate.target.category
  }
  category ??= loadCandidates(ctx).filter((c) => c.cause_key === key).at(-1)?.category ?? null
  if (!category || !ctx.config.candidates.categories.includes(category)) {
    throw new UsageError(`--category が必要です（${ctx.config.candidates.categories.join('、')}）`)
  }
  const result = addPending(ctx, {
    key, category, signal, rootCause, severity, area,
    asked: r.required('asked', r.text), expected: r.required('expected', r.text), actual: r.required('actual', r.text),
    evidence: r.text('evidence') ?? '', proposalKind, proposal: r.text('proposal'), by: locked ? 'auto' : 'human',
  }, locked ? lock : null)
  const lines = [`失敗票の下書きを書きました：${key}（材料にした候補 ${result.consumed.length} 件を consumed にしました）`]
  if (result.related.length) lines.push(`同じ原因の失敗票：${result.related.join('、')}`)
  if (result.recurrence) lines.push(`試用中の原因の再発として数えました（${result.recurrence} 回目）。`)
  if (locked) {
    registerChange(ctx, lock, { kind: proposalKind ? 'proposal' : 'draft', key, ref: `pending:${key}` })
    if (proposalKind) lines.push('承認待ちの案として登録しました。')
  }
  out(lines.join('\n'))
  return 0
}

// ---- 実行の記録 ----

function cmdReport(ctx, positional, flags) {
  const sub = positional[0]
  const state = loadAuto(ctx)
  if (sub === 'list') {
    makeReader(flags, [])
    if (flags.json) return json(state.reports), 0
    out(state.reports.length ? state.reports.map((rep) => `- ${rep.name}  ${summaryLine(rep)}`).join('\n') : '自動改善の記録はありません。')
    return 0
  }
  if (sub === 'show') {
    makeReader(flags, [])
    const name = positional[1] ?? state.reports.at(-1)?.name
    const text = name ? readReport(ctx, name) : null
    if (text === null) return fail('自動改善の記録がありません')
    out(text)
    return 0
  }
  if (sub === 'close') {
    makeReader(flags, [])
    // 自動改善のセッション（ロック中、lock を試みたセッション）は、人に向けた知らせを閉じない。
    const writer = writerSession(ctx, flags)
    const refusal = humanOnlyRefusal(ctx, writer)
    if (refusal) return refuse(refusal)
    // セッションを確かめられないとき（ID が推定）も、閉じない。自動改善のセッションかどうかを見分けられないため。
    if (estimated(writer.session)) return refuse(NEEDS_SESSION)
    const closed = closeNotices(ctx)
    out(closed ? `セッション開始時の知らせを ${closed} 件閉じました。未確認の自動変更が残っているあいだは、件数の 1 行だけ出ます。` : '閉じる知らせはありません。')
    return 0
  }
  if (sub !== 'write') throw new UsageError('使い方：harness-note report write|list|show|close')
  const r = makeReader(flags, ['body'])
  const session = resolveSession(ctx, flags)
  const lock = activeLock(ctx)
  if (!lock || lock.session_id !== session.id) {
    return fail('実行の記録を書けるのは、harness-note lock で登録した自動改善のセッションだけです')
  }
  const body = r.text('body') ?? ''
  if (body.length > 20000) throw new UsageError('--body は 20000 文字までです')
  const result = writeReport(ctx, lock, body)
  out(`実行の記録を書きました：${result.name}\n${summaryLine(result.report)}\n次のセッション開始時に報告されます。最後に harness-note unlock を実行してください。`)
  return 0
}

// ---- ロック ----

function gateSummary(ctx) {
  const state = loadAuto(ctx)
  const measure = measureAlwaysLoaded(ctx)
  return {
    unreviewed: unreviewed(state).length,
    max_unreviewed: ctx.config.auto.max_unreviewed,
    trial_rules: listRules(ctx).length,
    max_trial_rules: ctx.config.auto.max_trial_rules,
    trial_skills: listSkills(ctx).length,
    max_trial_skills: ctx.config.auto.max_trial_skills,
    // self-improve が読み込ませる行数（試用ルール＋自分専用のルール）と、その目安。
    rule_lines: measure.rule_lines,
    personal_rules: measure.personal_rules,
    rule_limit: measure.rule_limit,
    blocked: blockedReasons(ctx, state),
  }
}

function describeTarget(t, i) {
  let what
  if (t.mode === 'recurrence') {
    what = `試用中の原因の再発（${t.recurrence_no} 回目）。${t.allowed.length ? '文言の編集（trial edit）ができます' : '編集しません。ガードや検証コマンドへ移す案（pending add --proposal-kind）だけ'}`
  } else if (t.blocked) {
    what = `新規。ただし、いまは追加できません（${t.blocked}）。下書きは作らず、理由を報告に書いてください`
  } else {
    const off = [t.limits?.rule, t.limits?.skill].filter(Boolean)
    what = `新規。${t.allowed.join(' か ')}${t.allowed.length > 1 ? ' のどちらか 1 つ' : ' だけ'}${off.length ? `（${off.join('。')}）` : ''}`
  }
  return `${i + 1}. ${t.key}（${t.category}、${t.sessions} セッション）— ${what}`
}

function cmdLock(ctx, flags) {
  makeReader(flags, [])
  const session = resolveSession(ctx, flags)
  if (estimated(session)) {
    return fail('セッション ID が分かりません。harness-note lock --session <セッションID> の形で呼んでください')
  }
  const result = acquireLock(ctx, session.id)
  if (flags.json) return json({ ...result, gates: gateSummary(ctx) }), 0
  if (!result.run) return refuse(result.message)
  const g = gateSummary(ctx)
  const full = g.unreviewed >= g.max_unreviewed
  out([
    `自動改善を開始しました（セッション ${short(session.id)}、ロックは 2 時間で失効します）。`,
    `対象（${ctx.config.auto.max_per_run} 件まで。件数の多い順にスクリプトが選びました。これ以外は扱いません）：`,
    ...(result.lock.targets.length ? result.lock.targets.map(describeTarget) : ['  なし（追加・編集はせず、報告だけ書いて終了してください）']),
    `未確認の自動変更：${g.unreviewed} 件（上限 ${g.max_unreviewed} 件）${full ? ' → 上限に達しています。追加も編集もせず、報告だけにしてください' : ''}`,
    `試用ルール ${g.trial_rules}/${g.max_trial_rules} 件、試用Skill ${g.trial_skills}/${g.max_trial_skills} 件、読み込ませるルール（試用＋自分専用）${g.rule_lines}/${g.rule_limit} 行`,
    'このセッションでは、Read・Grep・Glob と harness-note 以外のツールは拒否されます。harness-note には、毎回 --session を付けてください。最後に report write、そのあとに unlock を実行します。',
  ].join('\n'))
  return 0
}

function cmdUnlock(ctx, flags) {
  makeReader(flags, [])
  const session = resolveSession(ctx, flags)
  // 推定の ID では外さない（別のセッションが、自動改善のロックを外してしまうのを防ぐ）。
  if (estimated(session)) return fail('セッション ID が分かりません。harness-note unlock --session <セッションID> の形で呼んでください')
  const result = releaseLock(ctx, session.id)
  if (flags.json) return json({ released: result.released, reason: result.reason ?? null }), 0
  if (result.released) out('自動改善のロックを解除しました。このセッションでは、このあとも書き込みに確認が挟まり、harness-note での試用の追加や確認の記録は見送りになります（自動改善を呼び出したセッションのため）。作業や確認を続けるなら、新しいセッションで行ってください。')
  else if (result.reason === 'no_report') return refuse('見送り：先に harness-note report write で実行の記録を書いてください。ロックを外せるのは、そのあとです。')
  else out(result.reason === 'other' ? '別のセッションのロックなので、解除しません。' : 'ロックはありません。')
  return 0
}

function cmdTargets(ctx, flags) {
  makeReader(flags, [])
  const state = loadAuto(ctx)
  const targets = computeTargets(ctx, state)
  const value = { targets, per_run: ctx.config.auto.max_per_run, interval: intervalState(ctx, state), gates: gateSummary(ctx) }
  if (flags.json) return json(value), 0
  out(targets.length ? targets.map(describeTarget).join('\n') : '自動改善の対象になる原因キーは、まだありません。')
  return 0
}

function cmdStatus(ctx, flags) {
  makeReader(flags, [])
  const session = resolveSession(ctx, flags)
  const state = loadAuto(ctx)
  const lock = activeLock(ctx)
  const value = {
    repo: { name: ctx.repo.name, id: ctx.repo.id, root: ctx.repo.root },
    data_dir: ctx.data,
    data_dir_source: ctx.dataSource,
    session,
    // user 側の置き場所と、設定の読み込みの結果。recording が false なら、記録と掃除を止めている。
    user_dir: tildePath(ctx.user.dir),
    repo_dir: tildePath(ctx.user.repoDir),
    incidents_dir: tildePath(ctx.user.incidents),
    recording: ctx.recording,
    config_files: Object.fromEntries(Object.entries(ctx.config.files).map(([k, f]) => [k, { path: k === 'repo' ? 'harness/config.json' : tildePath(f), exists: existsSync(f) }])),
    config_errors: ctx.config.errors,
    // リポジトリの検証コマンドの件数と、実行を許可しているか（harness-note verify trust）。
    verify: { count: ctx.config.verify.length, trusted: ctx.config.verify_trust.trusted, changed: ctx.config.verify_trust.changed },
    config_notes: ctx.config.notes,
    guard_files: guardFiles(ctx).map((g) => ({ source: g.source, path: g.label, exists: existsSync(g.file) })),
    // ロックの ID は全文では出さない（ほかのセッションが名乗れないように）。
    lock: lock ? { session: lock.broken ? null : short(lock.session_id), at: lock.at, mine: lock.session_id === session.id, broken: Boolean(lock.broken) } : null,
    auto_session: isAutoSession(ctx, session.id),
    interval: intervalState(ctx, state),
    gates: gateSummary(ctx),
    candidates: { new: loadCandidates(ctx).filter((c) => c.status === 'new').length },
    targets: computeTargets(ctx, state).map((t) => t.key),
    decisions: decisionStats(state),
  }
  if (flags.json) return json(value), 0
  out([
    `リポジトリ：${value.repo.name}（${value.repo.id}）`,
    `データの置き場所：${value.data_dir}（${{ env: '環境変数', handoff: 'セッション開始時の引き渡し', default: '既定のパスの計算' }[value.data_dir_source]}）`,
    `セッション：${session.id}（${{ flag: '--session', env: '環境変数', recent: '直近のセッションから推定', unknown: '不明' }[session.source]}）`,
    `ロック：${lock ? (lock.broken ? 'ファイルを読めません（書き込みは拒否されます）' : `${short(lock.session_id)}… が ${lock.at} から${value.lock.mine ? '（このセッション）' : ''}`) : 'なし'}`,
    `自動改善：${value.interval.enabled ? `間隔 ${ctx.config.auto.interval_days} 日、前回 ${value.interval.last_run_at ?? 'なし'}${value.interval.next_run_from ? `、次に実行できるのは ${value.interval.next_run_from} 以降` : ''}` : '停止中（interval_days が 0）'}`,
    `設定：${Object.values(value.config_files).filter((f) => f.exists).map((f) => f.path).join('、') || 'なし（初期値で動いています）'}。リポジトリごとの置き場所：${value.repo_dir}`,
    `ガードの定義：${value.guard_files.filter((g) => g.exists).map((g) => g.path).join('、')}`,
    `検証コマンド：${value.verify.count ? `${value.verify.count} 件、${value.verify.trusted ? '許可済み' : `${value.verify.changed ? '中身が変わったので' : ''}許可待ち（実行していません。harness-note verify で中身を確かめ、verify trust で許可します）`}` : 'なし'}`,
    `未確認の自動変更 ${value.gates.unreviewed}/${value.gates.max_unreviewed} 件、試用ルール ${value.gates.trial_rules}/${value.gates.max_trial_rules} 件、試用Skill ${value.gates.trial_skills}/${value.gates.max_trial_skills} 件、読み込ませるルール（試用＋自分専用）${value.gates.rule_lines}/${value.gates.rule_limit} 行`,
    ...(value.gates.blocked.length && value.interval.enabled ? [`自動改善は、いま試用を追加しません：${value.gates.blocked.join('。')}`] : []),
    `new の改善候補 ${value.candidates.new} 件、対象になる原因キー：${value.targets.join('、') || 'なし'}`,
    `自動改善の採否：残した ${value.decisions.kept} 件、消した ${value.decisions.removed} 件`,
    ...ctx.config.errors.map((e) => `警告：${e}`),
    ...ctx.config.notes.map((n) => `注意：${n}`),
  ].join('\n'))
  return 0
}

function cmdReview(ctx, positional, flags) {
  if (positional[0] !== 'done') {
    makeReader(flags, [])
    const items = reviewItems(ctx)
    // 確認を開いたので、セッション開始時の知らせを閉じる。自動改善のセッションが開いたとき、自動改善の実行中、
    // セッションを確かめられないとき（ID が推定）は、閉じない。
    const session = resolveSession(ctx, flags)
    const quiet = isLocked(ctx, session.id) || isAutoSession(ctx, session.id) || activeLock(ctx) || estimated(session)
    if (!quiet) closeNotices(ctx)
    return json(items), 0
  }
  const r = makeReader(flags, ['decision', 'incident'])
  const id = positional[1]
  if (!id) throw new UsageError('使い方：harness-note review done <変更ID> --decision keep|edit|remove|apply|dismiss')
  const decision = r.required('decision')
  if (decision === 'promote') throw new UsageError('昇格は、harness-note promote --key <原因キー> --to personal|team で行います（確認済みにもなります）')
  if (!DECISIONS.includes(decision)) throw new UsageError(`--decision は次のどれかです：${DECISIONS.join('、')}`)
  const incident = r.one('incident')
  if (incident && !INCIDENT_ID.test(incident)) throw new UsageError('--incident は失敗票の ID（INC-YYYY-NNNN）です')
  const writer = writerSession(ctx, flags)
  if (writer.locked) return refuse('見送り：自動改善のセッションでは、確認の結果を記録しません。確認は人が行います。')
  const refusal = humanOnlyRefusal(ctx, writer)
  if (refusal) return refuse(refusal)
  const result = reviewDone(ctx, id, decision, { incident })
  if (!result.ok) return fail(result.errors)
  out([`${id}（${result.change.cause_key}）を確認済みにしました：${decision}`, ...result.notes].join('\n'))
  return 0
}

// ---- 失敗票 ----

// 失敗票は、全リポジトリの分を user 側（~/.claude/self-improve/incidents/）に置く。起票は人だけの操作。
function cmdIncident(ctx, positional, flags) {
  const sub = positional[0]
  if (sub === 'list') {
    makeReader(flags, ['all'])
    const rows = (flags.all ? listIncidents(ctx) : repoIncidents(ctx)).map((i) => ({
      id: i.id, repo: i.data.repo ?? null, cause_key: i.data.cause_key ?? null, status: i.data.status ?? null, control: i.data.control ?? null, date: i.data.date ?? null,
    }))
    if (flags.json) return json(rows), 0
    if (!rows.length) return out(flags.all ? '失敗票はありません。' : 'このリポジトリの失敗票はありません（全リポジトリの分は --all）。'), 0
    for (const row of rows) out(`- ${row.id}［${row.status}］${row.cause_key}（${row.repo}、${row.date}）${row.control && row.control !== 'null' ? ` → ${row.control}` : ''}`)
    return 0
  }
  if (sub === 'show') {
    makeReader(flags, [])
    const incident = getIncident(ctx, positional[1])
    if (!incident) return fail(`失敗票 ${positional[1] ?? ''} がありません`)
    out(incident.text.trimEnd())
    return 0
  }
  if (sub === 'set') {
    const r = makeReader(flags, ['status', 'control'])
    const id = positional[1]
    if (!id || !INCIDENT_ID.test(id)) throw new UsageError('使い方：harness-note incident set <INC-YYYY-NNNN> --status <状態> [--control <足した制御の場所>]')
    const changes = {}
    if (r.has('status')) {
      const status = r.one('status')
      if (!INCIDENT_STATUSES.includes(status)) throw new UsageError(`--status は次のどれかです：${INCIDENT_STATUSES.join('、')}`)
      changes.status = status
    }
    if (r.has('control')) changes.control = r.one('control')
    if (!Object.keys(changes).length) throw new UsageError('--status か --control が必要です')
    const refusal = humanOnlyRefusal(ctx, writerSession(ctx, flags))
    if (refusal) return refuse(refusal)
    const result = updateIncident(ctx, id, changes)
    if (!result.ok) return fail(result.errors)
    out(`失敗票 ${id} を更新しました（${Object.entries(changes).map(([k, v]) => `${k}: ${v}`).join('、')}）。`)
    return 0
  }
  if (sub === 'import') {
    // 1.x の失敗票（リポジトリの harness/incidents/）を、user 側へ取り込む。
    makeReader(flags, [])
    const refusal = humanOnlyRefusal(ctx, writerSession(ctx, flags))
    if (refusal) return refuse(refusal)
    const result = importIncidents(ctx)
    const lines = []
    const renamed = result.imported.filter((i) => i.from !== i.id)
    // 番号を振り直した票を指している試用ルールは、新しい ID に付け替える。
    for (const rule of listRules(ctx)) {
      const moved = renamed.find((i) => i.from === rule.ref)
      if (moved) {
        editRule(ctx, { key: rule.cause_key, text: null, ref: moved.id, by: rule.by })
        lines.push(`試用ルール ${rule.cause_key} の失敗票 ID を ${moved.id} に付け替えました`)
      }
    }
    // 取り込み元のリポジトリを、どの出力にも書く（他人のリポジトリの票が、user 全体の票に混ざっていないかを確かめられるように）。
    const from = `リポジトリ ${ctx.repo.name} の harness/incidents/`
    if (result.imported.length) {
      lines.unshift(`失敗票を ${result.imported.length} 件取り込みました（取り込み元：${from}、取り込み先：${tildePath(ctx.user.incidents)}）：${result.imported.map((i) => (i.from === i.id ? i.id : `${i.from} → ${i.id}`)).join('、')}`)
      lines.push('もとのファイル（harness/incidents/）は消していません。取り込んだ内容を確かめてから、リポジトリから消してください。')
      if (renamed.length) lines.push('番号を振り直した票があります（ほかのリポジトリの票と番号が重なったため）。リポジトリのファイルに古い ID を書いていれば、直してください。')
    }
    if (result.skipped.length) lines.push(`取り込み済みなので飛ばしました（${from}）：${result.skipped.map((i) => i.from).join('、')}`)
    if (!result.imported.length && !result.skipped.length && !result.errors.length) lines.push(`取り込む失敗票はありません（${from} に INC-YYYY-NNNN.md がありません）。`)
    if (lines.length) out(lines.join('\n'))
    return result.errors.length ? fail(result.errors) : 0
  }
  if (sub !== 'add') throw new UsageError('使い方：harness-note incident add|list|show|set|import')

  const r = makeReader(flags, ['key', 'from-draft', 'status', 'control', 'root-cause', 'category', 'signal', 'severity', 'area', 'asked', 'expected', 'actual', 'evidence'])
  const key = requireKey(r.required('key'))
  const pick = (name, allowed, label) => {
    const value = r.one(name)
    if (value !== null && !allowed.includes(value)) throw new UsageError(`--${name} は次のどれかです：${allowed.join('、')}`)
    return value
  }
  const flagsFields = {
    status: pick('status', INCIDENT_STATUSES),
    root_cause: pick('root-cause', ROOT_CAUSES),
    signal: pick('signal', SIGNALS),
    severity: pick('severity', ['normal', 'high']),
    category: pick('category', ctx.config.candidates.categories),
    control: r.one('control'),
    area: r.one('area'),
  }
  if (flagsFields.area && !/^[A-Za-z0-9_./-]{1,40}$/.test(flagsFields.area)) throw new UsageError('--area は英数字の短い名前にしてください')
  const given = Object.fromEntries(Object.entries(flagsFields).filter(([, v]) => v !== null))
  let fields
  let body
  if (r.has('from-draft')) {
    // 下書きから起票する。下書きに入っている値（status、control、root_cause、試用を始めた日など）を引き継ぐ。
    const draft = readPending(ctx, key)
    if (draft === null) return fail(`${key} の下書きがありません（harness-note pending list で確かめてください）`)
    const parsed = parseFrontmatter(draft)
    const d = parsed.data ?? {}
    const keep = (name) => (d[name] === undefined || d[name] === null || d[name] === 'null' ? {} : { [name]: d[name] })
    fields = {
      ...keep('area'), ...keep('category'), ...keep('signal'), ...keep('root_cause'), ...keep('severity'), ...keep('status'), ...keep('control'),
      ...keep('applied_by'), ...keep('trial_started_at'), ...keep('promoted_at'),
      ...given, cause_key: key,
    }
    body = parsed.body
  } else {
    if (!given.root_cause) throw new UsageError('--root-cause が必要です（下書きから起票するなら --from-draft）')
    const category = given.category ?? loadCandidates(ctx).filter((c) => c.cause_key === key).at(-1)?.category ?? null
    if (!category) throw new UsageError(`--category が必要です（${ctx.config.candidates.categories.join('、')}）`)
    fields = { ...given, category, cause_key: key }
    const evidence = r.text('evidence')
    body = [
      '## 何を頼んだか', '', r.required('asked', r.text), '',
      '## 期待した結果', '', r.required('expected', r.text), '',
      '## 実際の結果', '', r.required('actual', r.text), '',
      '## 根拠', '', evidence ?? '', '',
    ].join('\n')
  }
  if ((fields.status === 'trial' || fields.status === 'converted') && !fields.control) {
    throw new UsageError(`status が ${fields.status} のときは、--control（足した制御の場所）が必要です`)
  }
  const refusal = humanOnlyRefusal(ctx, writerSession(ctx, flags))
  if (refusal) return refuse(refusal)
  const result = addIncident(ctx, { fields, body })
  if (!result.ok) return fail(result.errors)
  const lines = [`失敗票を起票しました：${result.id}（${tildePath(result.file)}）`]
  if (result.related.length) lines.push(`同じ原因の失敗票（このリポジトリ）：${result.related.join('、')}`)
  if (r.has('from-draft') && removePending(ctx, key)) lines.push('下書きは、起票したので捨てました。')
  out(lines.join('\n'))
  return 0
}

// ---- 検証コマンドの許可 ----

// リポジトリの harness/config.json の verify は、人が許可した中身と一致するときだけ実行する。
//   harness-note verify          いまの検証コマンドの一覧と、許可されているか
//   harness-note verify trust    一覧を出してから、いまの中身を許可したと記録する（人だけの操作）
function describeVerify(ctx) {
  return ctx.config.verify.map((v, i) => `${i + 1}. ${v.name}：${v.run}（制限時間 ${v.timeout_sec} 秒）`)
}
function cmdVerify(ctx, positional, flags) {
  const sub = positional[0] ?? 'show'
  const trust = ctx.config.verify_trust
  if (sub === 'show') {
    makeReader(flags, [])
    const value = { verify: ctx.config.verify, trusted: trust.trusted, changed: trust.changed, hash: trust.hash, trust_file: tildePath(verifyTrustFile(ctx.repo)) }
    if (flags.json) return json(value), 0
    if (!ctx.config.verify.length) return out('検証コマンドは設定されていません（harness/config.json の verify が空か、ファイルがありません）。'), 0
    out([
      `harness/config.json の検証コマンド（リポジトリの根で、上から順に実行します）：`,
      ...describeVerify(ctx),
      trust.trusted
        ? '許可済みです。変更のあったターンの終わりに実行します。'
        : `${trust.changed ? '前に許可したときから中身が変わっています。' : 'まだ許可されていません。'}実行していません。許可するには harness-note verify trust を実行します。`,
    ].join('\n'))
    return 0
  }
  if (sub !== 'trust') throw new UsageError('使い方：harness-note verify [show] | verify trust')
  makeReader(flags, [])
  if (!ctx.config.verify.length) return refuse('許可するものはありません（harness/config.json の verify が空か、ファイルがありません）。')
  // 人だけの操作。自動改善のセッション、lock を試みたセッション、自動改善の実行中は、見送る。
  const writer = writerSession(ctx, flags)
  const refusal = humanOnlyRefusal(ctx, writer)
  if (refusal) return refuse(refusal)
  // セッションを確かめられないとき（ID が推定）は、自動改善のセッションかどうかを見分けられないので、記録しない。
  if (estimated(writer.session)) return refuse('見送り：どのセッションからの操作かを確かめられないので、許可は記録しません。harness-note verify trust --session <セッションID> の形で呼んでください。')
  const lines = ['次の検証コマンドを、変更のあったターンの終わりに実行します（リポジトリの根で、上から順に）：', ...describeVerify(ctx)]
  if (trust.trusted) {
    lines.push('この中身は、すでに許可済みです。')
  } else {
    const file = recordVerifyTrust(ctx)
    lines.push(`この中身を許可したと記録しました（${tildePath(file)}）。harness/config.json の verify が変わったときは、もう一度許可が要ります。`)
  }
  out(lines.join('\n'))
  return 0
}

// ---- 昇格 ----

// 試用を、自分専用（personal）かチーム（team）へ昇格する。人だけの操作。未確認の変更があれば、確認済みにもなる。
function cmdPromote(ctx, flags) {
  const r = makeReader(flags, ['key', 'to', 'path', 'incident'])
  const key = requireKey(r.required('key'))
  const to = r.required('to')
  if (!['personal', 'team'].includes(to)) throw new UsageError('--to は personal（自分専用）か team（チーム）です')
  const incident = r.one('incident')
  if (incident && !INCIDENT_ID.test(incident)) throw new UsageError('--incident は失敗票の ID（INC-YYYY-NNNN）です')
  const refusal = humanOnlyRefusal(ctx, writerSession(ctx, flags))
  if (refusal) return refuse(refusal)
  const result = promote(ctx, { key, to, path: r.one('path'), incident })
  if (!result.ok) return fail(result.errors)
  out([`${key} を${to === 'personal' ? '自分専用' : 'チーム'}へ昇格しました。`, ...result.notes].join('\n'))
  return 0
}

// ---- 入口 ----

const USAGE = `harness-note <サブコマンド>
  add / keys / list / mark / rekey      改善候補
  episodes                              事象メモ
  trial add|edit|remove|list            試用ルール
  skill add|remove|list                 試用 Skill
  pending add|list|show|remove          失敗票の下書き
  incident add|list|show|set|import     失敗票（全リポジトリの分を user 側に置く。import は 1.x の票の取り込み）
  promote                               試用を、自分専用かチームへ昇格する
  verify [show] | verify trust          リポジトリの検証コマンドの一覧と、実行の許可（許可は人だけの操作）
  report write|list|show|close          自動改善の記録、知らせを閉じる
  lock / unlock / targets / status      自動改善のセッション
  review / review done                  未確認の自動変更`

function main(argv) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (e) {
    return fail(e.message)
  }
  const { positional, flags } = parsed
  const command = positional.shift()
  if (!command || flags.help || command === 'help') {
    out(USAGE)
    return 0
  }
  const ctx = makeContext(process.cwd())
  if (!ctx) return fail(`ここでは使えません：${inactiveReason(process.cwd()) ?? 'self-improve が動いていません'}`)
  try {
    switch (command) {
      case 'add': return cmdAdd(ctx, flags)
      case 'keys': return cmdKeys(ctx, flags)
      case 'list': return cmdList(ctx, flags)
      case 'mark': return cmdMark(ctx, positional, flags)
      case 'rekey': return cmdRekey(ctx, positional, flags)
      case 'episodes': return cmdEpisodes(ctx, positional, flags)
      case 'trial': return cmdTrial(ctx, positional, flags)
      case 'skill': return cmdSkill(ctx, positional, flags)
      case 'pending': return cmdPending(ctx, positional, flags)
      case 'report': return cmdReport(ctx, positional, flags)
      case 'incident': return cmdIncident(ctx, positional, flags)
      case 'promote': return cmdPromote(ctx, flags)
      case 'verify': return cmdVerify(ctx, positional, flags)
      case 'lock': return cmdLock(ctx, flags)
      case 'unlock': return cmdUnlock(ctx, flags)
      case 'targets': return cmdTargets(ctx, flags)
      case 'status': return cmdStatus(ctx, flags)
      case 'review': return cmdReview(ctx, positional, flags)
      default: return fail(`知らないサブコマンドです：${command}\n${USAGE}`)
    }
  } catch (e) {
    if (e instanceof UsageError) return fail(e.message)
    return fail(`内部エラー：${e.stack || e.message}`)
  }
}

process.exitCode = main(process.argv.slice(2))
