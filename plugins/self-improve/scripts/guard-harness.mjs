// PreToolUse のガード。matcher は付けず、すべてのツールを見る。
//   禁止操作            → 終了コード 2 で拒否する（理由と直し方を標準エラーに書く。終了コード 1 はブロックにならない）
//   ハーネスのファイル  → permissionDecision: "ask" を返し、必ず確認を出す
//   自動改善のセッション → Read・Grep・Glob・Skill と harness-note 以外のツールを、すべて拒否する（確認は出さない）
// 関係のないツール（ふだんのセッションの Read など）は、ロックを確かめたらすぐに抜ける。
// 拒否は、自分で生ログに記録する。HARNESS_GUARD_DRYRUN=1 のとき（test-guards.mjs）は記録しない。
import { heartbeat, hookContext, isLocked, isMain, logEvent, readHookInput } from './lib/core.mjs'
import { evaluate } from './lib/guard.mjs'

export function guard(input) {
  const ctx = hookContext(input)
  if (!ctx) return { code: 0 }
  const result = evaluate(ctx, input)
  if (result.decision === 'deny') {
    if (process.env.HARNESS_GUARD_DRYRUN !== '1' && !isLocked(ctx)) {
      heartbeat(ctx, 'guard')
      logEvent(ctx, { type: 'guard_denied', prompt_id: input.prompt_id ?? null, rule: result.rule, tool: input.tool_name, target: result.target ?? null })
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

if (isMain(import.meta.url)) {
  try {
    const result = guard(readHookInput())
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(`${result.stderr}\n`)
    process.exitCode = result.code
  } catch (error) {
    // ガード自身の不具合で、作業を止めない（終了コード 1 はブロックにならない）。
    process.stderr.write(`[self-improve] guard-harness で内部エラー：${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}
