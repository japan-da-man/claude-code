// PreToolUse のガード。matcher は付けず、すべてのツールを見る。
//   禁止操作            → 終了コード 2 で拒否する（理由と直し方を標準エラーに書く。終了コード 1 はブロックにならない）
//   ハーネスのファイル  → permissionDecision: "ask" を返し、必ず確認を出す
//   自動改善のセッション → Read・Grep・Glob と harness-note 以外のツールを、すべて拒否する（確認は出さない）
// 拒否は、自分で生ログに記録する。HARNESS_GUARD_DRYRUN=1 のとき（test-guards.mjs）は記録しない。
//
//
// すべてのツール呼び出しで、すべてのリポジトリで動くので、先頭では Node.js の標準と scope.mjs（標準だけで書いてある）
// だけを使い、することがないと分かった時点で抜ける（lib/ のほかの読み込みは、そのあとで行う）。先に抜けるのは、次のとき。
//   - self-improve が動かない場所（git リポジトリでない、除外してある、HARNESS_DISABLE=1）。判定は scope.mjs で、
//     記録する側と同じものを使う
//   - ファイルの書き込みでも Bash でもなく、ロックがどこにもなく、このセッションが lock を試みた記録もない
// どちらも「あとの判定でも何もしない」と確かめられる場合だけで、迷うときは先へ進む。
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveScope } from './lib/scope.mjs'

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'])

function readInput() {
  try {
    const parsed = JSON.parse(readFileSync(0, 'utf8') || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

// ロックのファイルが、まだ効いているかもしれないか。ロックは 2 時間で失効する（読めないファイルも、更新から 2 時間）。
// ファイルは実行の途中でしか書き換わらないので、更新から 2 時間を過ぎていれば、失効している。
// 時刻を固定するテスト（HARNESS_TEST=1）では、実際の時計で判定しない。
const LOCK_MS = 2 * 60 * 60 * 1000
function lockMayBeActive(file) {
  try {
    const { mtimeMs } = statSync(file)
    return process.env.HARNESS_TEST === '1' || mtimeMs > Date.now() - LOCK_MS - 60_000
  } catch (e) {
    return e?.code !== 'ENOENT'
  }
}

// ロックも、このセッションが lock を試みた記録も、データ領域のどこにもないと言い切れるか。
// データ領域の場所が環境変数から分からないとき、読めないファイルがあるときは、言い切らない（false）。
function noAutoState(sessionId) {
  const data = process.env.HARNESS_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA
  if (!data || !isAbsolute(data)) return false
  const base = join(data, 'state')
  if (!existsSync(base)) return true
  const sid = `"${String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128)}"`
  try {
    for (const repoId of readdirSync(base)) {
      if (lockMayBeActive(join(base, repoId, 'lock.json'))) return false
      const auto = join(base, repoId, 'auto.json')
      if (existsSync(auto) && readFileSync(auto, 'utf8').includes(sid)) return false
    }
  } catch {
    return false
  }
  return true
}

// あとの判定でも何もしないと分かっているか。
export function nothingToDo(input) {
  if (!resolveScope(input.cwd).active) return true
  if (WRITE_TOOLS.has(String(input.tool_name ?? ''))) return false
  return noAutoState(input.session_id)
}

export async function guard(input) {
  if (nothingToDo(input)) return { code: 0 }
  const { heartbeat, hookContext, isLocked, logEvent } = await import('./lib/core.mjs')
  const { NOTE_CALL_RULE, evaluate } = await import('./lib/guard.mjs')
  const ctx = hookContext(input)
  if (!ctx) return { code: 0 }
  const result = evaluate(ctx, input)
  if (result.decision === 'deny') {
    // harness-note の呼び出し方の検査（書式の検査）による拒否は、失敗の信号に数えない。
    // user の設定が読めないあいだは、拒否はするが、記録はしない（logEvent が書かない）。
    if (process.env.HARNESS_GUARD_DRYRUN !== '1' && !isLocked(ctx) && result.rule !== NOTE_CALL_RULE) {
      heartbeat(ctx, 'guard')
      // source は、どのファイルのルールか（共通リスト、user 側、リポジトリ）。組み込みの判定は builtin。
      logEvent(ctx, { type: 'guard_denied', prompt_id: input.prompt_id ?? null, rule: result.rule, source: result.source ?? 'builtin', tool: input.tool_name, target: result.target ?? null })
    }
    return { code: 2, stderr: `[self-improve] ${result.message}（ルール：${result.rule}）` }
  }
  if (result.decision === 'ask') {
    return {
      code: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: result.message },
      }),
    }
  }
  return { code: 0 }
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  try {
    const result = await guard(readInput())
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(`${result.stderr}\n`)
    process.exitCode = result.code
  } catch (error) {
    // ガード自身の不具合で、作業を止めない（終了コード 1 はブロックにならない）。
    process.stderr.write(`[self-improve] guard-harness で内部エラー：${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}
