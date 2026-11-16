// ターン終了時（Stop）に、検証 → 事象メモ → 改善候補の確認を、この順で動かす。
// 同じイベントの hook は並列に走るので、別々の hook にせず、このスクリプトから順に呼ぶ。
//
// Claude に続けさせるのは 2 つの場合だけ。
//   - 検証が失敗したとき：終了コード 2 で、検証の結果だけを標準エラーに返す（連続 3 回で打ち切って、人に知らせる）
//   - 改善候補の確認を頼むとき：hookSpecificOutput.additionalContext で頼む。エラーではなく案内なので、
//     「hook のエラー」ではなく「hook からのフィードバック」として表示される。1 ターンに 1 回
//     （セッション ID とプロンプト ID の組で記録して止める）
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DAY_MS, heartbeat, hookContext, isLocked, isMain, iso, logEvent, now, readEvents, readHookInput, readJson, sessionDir, writeJson,
} from './lib/core.mjs'
import { loadCandidates, sessionCount } from './lib/candidates.mjs'
import { MAX_VERIFY_STREAK, describeFailure, verifyTurn } from './verify.mjs'
import { writeEpisode } from './episode.mjs'

const SIGNALS = new Set(['tool_failure', 'human_correction', 'guard_denied', 'verify_failed'])
// 1 ターンのあいだに、この hook が Claude を続けさせる回数の上限（万一の歯止め）。
const MAX_BLOCKS_PER_TURN = 6

function askMessage(ctx, { remaining, episode }) {
  const categories = ctx.config.candidates.categories.join(' / ')
  const episodeFlag = episode ? ` --episode ${episode}` : ''
  return [
    '[self-improve] ターン終了時の確認です。',
    'このターンで得た気づきのうち、次回以降の作業に効くもの（気づいたバグ、バグの原因、よくあるミス、ユーザーの好み）があれば、1 件 1 行で記録してください。',
    'なければ何も記録せず、説明も足さずに、そのまま終了してください。記録するのは、根拠がこのターンにあるものだけです。',
    '',
    '1. harness-note keys で既存の原因キーを確かめる。同じ原因なら、同じキーを使う',
    `2. harness-note add --session ${ctx.sessionId} --category <カテゴリ> --key <原因キー> --text "<1行>"${episodeFlag}`,
    `   カテゴリ：${categories}`,
    '   原因キー：英小文字とハイフンの短い名前（例：route-placement）',
    `3. このセッションで記録できるのは、あと ${remaining} 件。記録したら、ほかの作業はせずに終了する`,
  ].join('\n')
}

function verifyMessage(result) {
  const { failure, streak } = result
  return [
    `[self-improve] ${describeFailure(failure)}（連続 ${streak} 回目。${MAX_VERIFY_STREAK} 回続くと打ち切ります）`,
    '原因を直してから終了してください。直せないとき（環境の問題など）は、理由をユーザーに伝えてください。',
    ...(failure.incidents.length ? [`関連する失敗票：${failure.incidents.join('、')}`] : []),
    '--- 出力 ---',
    failure.output || '（出力なし）',
  ].join('\n')
}

export function onStop(input) {
  const ctx = hookContext(input)
  if (!ctx || !ctx.sessionId) return { code: 0 }
  // 自動改善のセッションでは、検証・事象メモ・改善候補の確認を動かさない。
  if (isLocked(ctx)) return { code: 0 }
  heartbeat(ctx, 'record')

  const dir = sessionDir(ctx)
  mkdirSync(dir, { recursive: true })

  const stopFile = join(dir, 'stop.json')
  const stop = readJson(stopFile, {}) || {}
  const turn = readJson(join(dir, 'turn.json'))
  const promptId = input.prompt_id ?? null
  const sameTurn = Boolean(turn && (promptId ? turn.prompt_id === promptId : true))
  const startedAt = sameTurn ? turn.at : stop.last_stop_at ?? null
  const turnKey = promptId ?? `t:${startedAt ?? 'start'}`

  // ターンごとの状態。同じターンの 2 回目以降の Stop では、前の状態を引き継ぐ。
  const state = stop.turn?.key === turnKey
    ? stop.turn
    : { key: turnKey, blocks: 0, asked: false, verified_at: null, previous: stop.last_turn ?? null }

  // 生ログは、ターンの始まりの少し前から読む（始まりが分からなければ、直近 1 日分）。
  const since = new Date((startedAt ? Date.parse(startedAt) : now().getTime() - DAY_MS) - 60 * 1000).toISOString()
  const events = readEvents(ctx, since).filter((e) => {
    if (e.session_id !== ctx.sessionId) return false
    if (promptId && e.prompt_id) return e.prompt_id === promptId
    return !startedAt || e.ts >= startedAt
  })
  const signals = events.filter((e) => SIGNALS.has(e.type))
  const changes = events.filter((e) => e.type === 'change')

  let block = null
  let guide = null
  let notice = null
  let unverifiedFailure = null

  // 1. 検証。そのターンでファイルの変更があったときだけ。検証が通ったあとに変更がなければ、繰り返さない。
  const unverified = changes.filter((c) => !state.verified_at || c.ts > state.verified_at)
  if (unverified.length && ctx.config.verify.length) {
    const result = verifyTurn(ctx, { promptId })
    if (result.ok) {
      state.verified_at = iso()
    } else {
      signals.push(result.event)
      unverifiedFailure = result.failure
      if (result.gaveUp) {
        notice = `[self-improve] ${describeFailure(result.failure)} ${MAX_VERIFY_STREAK} 回続けて失敗したので、検証を打ち切りました。コードは検証が通っていない状態です。harness/config.json の verify と、失敗の内容を確かめてください。`
      } else {
        block = verifyMessage(result)
      }
    }
  }

  // 2. 事象メモ。信号があったターンだけ。
  if (signals.length) {
    state.episode = writeEpisode(ctx, {
      sessionId: ctx.sessionId,
      promptId,
      turnKey,
      startedAt,
      prompt: sameTurn ? turn.prompt : null,
      previous: state.previous,
      signals,
      lastMessage: input.last_assistant_message ?? null,
      transcriptPath: input.transcript_path ?? null,
    })
  }

  // 3. 改善候補の確認。検証が失敗したときは、検証の結果だけを返す（確認は、検証が通ったあとの Stop で頼む）。
  if (!block && !notice && (signals.length || changes.length) && !state.asked) {
    const max = ctx.config.candidates.max_per_session
    // 上限は、そのセッションが直近 24 時間に記録した件数で数える。
    const recorded = sessionCount(loadCandidates(ctx), ctx.sessionId)
    if (recorded < max) {
      state.asked = true
      logEvent(ctx, { type: 'asked', prompt_id: promptId })
      guide = askMessage(ctx, { remaining: max - recorded, episode: state.episode ?? null })
    }
  }

  if (block || guide) {
    if (state.blocks >= MAX_BLOCKS_PER_TURN) {
      // 検証が失敗したまま打ち切るときは、そう書く。
      notice = unverifiedFailure
        ? `[self-improve] ${describeFailure(unverifiedFailure)} このターンで続行が ${MAX_BLOCKS_PER_TURN} 回に達したので、打ち切りました。コードは検証が通っていない状態です。`
        : `[self-improve] ターン終了時の確認が繰り返されたので、このターンでは打ち切りました（続行は ${MAX_BLOCKS_PER_TURN} 回まで）。`
      block = null
      guide = null
    } else {
      state.blocks += 1
    }
  }

  stop.turn = state
  stop.last_stop_at = iso()
  // 次のターンで訂正語が出たときのために、依頼文と応答を 1 ターン分だけ持っておく。
  stop.last_turn = { prompt_id: promptId, prompt: sameTurn ? turn.prompt : null, last_message: input.last_assistant_message ?? null, at: iso() }
  writeJson(stopFile, stop)

  if (block) return { code: 2, stderr: block }
  if (guide) return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: guide } }) }
  if (notice) return { code: 0, stdout: JSON.stringify({ systemMessage: notice }) }
  return { code: 0 }
}

if (isMain(import.meta.url)) {
  try {
    const result = onStop(readHookInput())
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(`${result.stderr}\n`)
    process.exitCode = result.code
  } catch (error) {
    // 仕組みの側の不具合で、作業を止めない。
    process.stderr.write(`[self-improve] on-stop で内部エラー：${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}
