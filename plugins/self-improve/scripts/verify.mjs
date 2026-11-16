// リポジトリの harness/config.json の verify（検証コマンド）を実行する。リポジトリのこのファイルから読むのは、verify だけ。
// 実行するのは、人が harness-note verify trust で許可した中身と一致するときだけ（呼び出し側が確かめる）。
// on-stop.mjs から呼ばれる（verifyTurn）。直接実行すれば、検証コマンドを 1 回走らせて結果を見られる：
//   node verify.mjs [リポジトリのパス]     失敗があれば終了コード 1。許可されていなければ実行せず、終了コード 1
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { inactiveReason, isMain, iso, logEvent, makeContext, readJson, sessionDir, untrustedVerifyMessage, writeJson } from './lib/core.mjs'

// 検証の失敗が続いたら、ここで打ち切って人に知らせる。
// 公式の連続 8 回の上限は、Claude がツールを呼ぶたびにリセットされるので、止め役にならない。
export const MAX_VERIFY_STREAK = 3
const OUTPUT_TAIL = 4000

// 実行中の検証コマンド。hook 自身が止められたときに、まとめて止める。
const running = new Set()

// 検証コマンドを、子孫のプロセスごと止める。
// シェルだけを止めると、その先で動いているテストランナーなどが残るので、プロセスグループに送る
// （検証コマンドは、自分のグループの先頭として起動してある）。
function killTree(child) {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // すでに終わっている
    }
  }
}

let signalsHooked = false
function hookSignals() {
  if (signalsHooked) return
  signalsHooked = true
  const stopAll = () => {
    for (const child of running) killTree(child)
  }
  // hook が制限時間などで止められたときも、検証コマンドを残さない。
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
    process.on(signal, () => {
      stopAll()
      process.exit(code)
    })
  }
  process.on('exit', stopAll)
}

// 検証コマンドを 1 つ実行する。制限時間を過ぎたら、子孫のプロセスごと止める。
function runOne(item, cwd) {
  hookSignals()
  return new Promise((done) => {
    let output = ''
    let timedOut = false
    let settled = false
    let child
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child) running.delete(child)
      done({ ...result, timedOut, output })
    }
    const keep = (chunk) => {
      output += chunk
      // 出力は、末尾だけを使う。ためすぎない。
      if (output.length > OUTPUT_TAIL * 8) output = output.slice(-OUTPUT_TAIL * 4)
    }
    const timer = setTimeout(() => {
      timedOut = true
      if (child) killTree(child)
      // グループを抜けた子孫が出力を握ったままでも、待ち続けない。
      setTimeout(() => finish({ code: null, error: null }), 2000).unref()
    }, item.timeout_sec * 1000)
    try {
      child = spawn(item.run, {
        shell: true,
        cwd,
        // 自分のプロセスグループの先頭として起動する（グループごと止めるため）。
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HARNESS_VERIFY: '1' },
      })
    } catch (error) {
      finish({ code: null, error })
      return
    }
    running.add(child)
    child.stdout.setEncoding('utf8').on('data', keep)
    child.stderr.setEncoding('utf8').on('data', keep)
    child.on('error', (error) => finish({ code: null, error }))
    child.on('close', (code) => finish({ code, error: null }))
  })
}

// 上から順に実行し、最初の失敗で止める。
export async function runVerify(ctx) {
  const results = []
  for (const item of ctx.config.verify) {
    const run = await runOne(item, ctx.repo.root)
    const ok = !run.error && !run.timedOut && run.code === 0
    const output = run.output.trim()
    results.push({
      name: item.name,
      run: item.run,
      ok,
      code: run.code,
      timed_out: run.timedOut,
      error: run.error && !run.timedOut ? run.error.message : null,
      output: output.length > OUTPUT_TAIL ? `…（前を省略）\n${output.slice(-OUTPUT_TAIL)}` : output,
      // 出力に含まれる失敗票の ID（リンターのエラー文に書いたもの）も拾う。
      incidents: [...new Set(output.match(/INC-\d{4}-\d{4}/g) ?? [])],
    })
    if (!ok) break
  }
  return { ok: results.every((r) => r.ok), results }
}

// ターン終了時の検証。セッションごとの連続失敗回数をデータ領域に記録する。
export async function verifyTurn(ctx, { promptId = null } = {}) {
  const file = join(sessionDir(ctx), 'verify.json')
  const state = readJson(file, {}) || {}
  const { ok, results } = await runVerify(ctx)
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
  const start = process.argv[2] || process.cwd()
  const ctx = makeContext(start)
  if (!ctx) {
    process.stderr.write(`${inactiveReason(start) ?? 'self-improve は、ここでは動いていません'}。\n`)
    process.exitCode = 1
  } else if (!ctx.config.verify.length) {
    process.stdout.write('検証コマンドは設定されていません（harness/config.json の verify が空）。\n')
  } else if (!ctx.config.verify_trust.trusted) {
    process.stderr.write(`${untrustedVerifyMessage(ctx)}\n`)
    process.exitCode = 1
  } else {
    const { ok, results } = await runVerify(ctx)
    for (const r of results) {
      process.stdout.write(`${r.ok ? 'OK ' : 'NG '} ${r.name}（${r.run}）${r.ok ? '' : `\n${describeFailure(r)}\n${r.output}`}\n`)
    }
    process.exitCode = ok ? 0 : 1
  }
}
