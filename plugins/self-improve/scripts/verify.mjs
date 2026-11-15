// harness/config.json の verify を実行する。
// on-stop.mjs から呼ばれる（verifyTurn）。直接実行すれば、検証コマンドを 1 回走らせて結果を見られる：
//   node verify.mjs [リポジトリのパス]     失敗があれば終了コード 1
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isMain, iso, logEvent, makeContext, readJson, sessionDir, writeJson } from './lib/core.mjs'

// 検証の失敗が続いたら、ここで打ち切って人に知らせる。
// 公式の連続 8 回の上限は、Claude がツールを呼ぶたびにリセットされるので、止め役にならない。
export const MAX_VERIFY_STREAK = 3
const OUTPUT_TAIL = 4000

// 上から順に実行し、最初の失敗で止める。
export function runVerify(ctx) {
  const results = []
  for (const item of ctx.config.verify) {
    const run = spawnSync(item.run, {
      shell: true,
      cwd: ctx.repo.root,
      encoding: 'utf8',
      timeout: item.timeout_sec * 1000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HARNESS_VERIFY: '1' },
    })
    const timedOut = run.error?.code === 'ETIMEDOUT'
    const ok = !run.error && run.status === 0
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim()
    results.push({
      name: item.name,
      run: item.run,
      ok,
      code: run.status,
      timed_out: timedOut,
      error: run.error && !timedOut ? run.error.message : null,
      output: output.length > OUTPUT_TAIL ? `…（前を省略）\n${output.slice(-OUTPUT_TAIL)}` : output,
      // 出力に含まれる失敗票の ID（リンターのエラー文に書いたもの）も拾う。
      incidents: [...new Set(output.match(/INC-\d{4}-\d{4}/g) ?? [])],
    })
    if (!ok) break
  }
  return { ok: results.every((r) => r.ok), results }
}

// ターン終了時の検証。セッションごとの連続失敗回数をデータ領域に記録する。
export function verifyTurn(ctx, { promptId = null } = {}) {
  const file = join(sessionDir(ctx), 'verify.json')
  const state = readJson(file, {}) || {}
  const { ok, results } = runVerify(ctx)
  mkdirSync(sessionDir(ctx), { recursive: true })
  if (ok) {
    writeJson(file, { streak: 0, last_ok_at: iso() })
    return { ok: true, results }
  }
  const failure = results.find((r) => !r.ok)
  const streak = (state.streak ?? 0) + 1
  const gaveUp = streak >= MAX_VERIFY_STREAK
  // 打ち切ったら数え直す。次に変更があったターンでは、また検証する。
  writeJson(file, { streak: gaveUp ? 0 : streak, last_fail_at: iso(), last_failed: failure.name })
  const event = logEvent(ctx, {
    type: 'verify_failed',
    prompt_id: promptId,
    name: failure.name,
    code: failure.code,
    timed_out: failure.timed_out,
    incidents: failure.incidents,
    streak,
    gave_up: gaveUp,
  })
  return { ok: false, results, failure, streak, gaveUp, event }
}

export function describeFailure(failure) {
  const why = failure.timed_out ? 'タイムアウトしました' : failure.error ? `実行できませんでした（${failure.error}）` : `終了コード ${failure.code} で失敗しました`
  return `検証「${failure.name}」（${failure.run}）が${why}。`
}

if (isMain(import.meta.url)) {
  const ctx = makeContext(process.argv[2] || process.cwd())
  if (!ctx) {
    process.stderr.write('harness/config.json がありません。先に /self-improve:init を実行してください。\n')
    process.exitCode = 1
  } else if (!ctx.config.verify.length) {
    process.stdout.write('検証コマンドは設定されていません（harness/config.json の verify が空）。\n')
  } else {
    const { ok, results } = runVerify(ctx)
    for (const r of results) {
      process.stdout.write(`${r.ok ? 'OK ' : 'NG '} ${r.name}（${r.run}）${r.ok ? '' : `\n${describeFailure(r)}\n${r.output}`}\n`)
    }
    process.exitCode = ok ? 0 : 1
  }
}
