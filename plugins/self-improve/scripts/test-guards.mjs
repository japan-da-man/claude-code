// ガードを入力 JSON でテストする。エージェントも実際のコマンドも動かさない。
// hook の入力 JSON を guard-harness.mjs に直接渡し、deny / ask / allow のどれになったかを期待と比べる。
//
//   node test-guards.mjs [リポジトリのパス] [--json]
//
// 実行するのは、共通リストのテスト（guards.default.test.json）と、そのリポジトリで効く 3 か所のテストケース
// （user 全体、user のリポジトリごと、リポジトリの harness/guards.test.json。あるものだけ）。
// テストケースの形：{ "name": "...", "tool": "Bash", "input": { "command": "..." }, "expect": "deny" | "ask" | "allow" }
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLUGIN_ROOT, isMain, makeContext, readJson, tildePath } from './lib/core.mjs'

const GUARD = join(PLUGIN_ROOT, 'scripts', 'guard-harness.mjs')
export const DEFAULT_TESTS = join(PLUGIN_ROOT, 'guards.default.test.json')

// ガードに入力を 1 つ流して、deny / ask / allow のどれになったかを返す。拒否は記録しない（HARNESS_GUARD_DRYRUN）。
// env で、ホームと user 側の設定の場所を差し替えられる（共通リストは、利用者の設定に左右されない場所で確かめる）。
export function decide(repoRoot, dataDir, test, extraEnv = {}) {
  const input = { session_id: 'test-guards', cwd: repoRoot, hook_event_name: 'PreToolUse', tool_name: test.tool, tool_input: test.input ?? {} }
  const env = { ...process.env, HARNESS_GUARD_DRYRUN: '1', HARNESS_DATA_DIR: dataDir, CLAUDE_PROJECT_DIR: repoRoot, ...extraEnv }
  delete env.HARNESS_DISABLE
  delete env.HARNESS_PROJECT_DIR
  const run = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(input), encoding: 'utf8', env })
  if (run.status === 2) return { decision: 'deny', detail: run.stderr.trim() }
  if (run.status !== 0) return { decision: 'error', detail: run.stderr.trim() }
  try {
    const decision = JSON.parse(run.stdout || '{}').hookSpecificOutput?.permissionDecision
    if (decision === 'ask' || decision === 'deny') return { decision, detail: JSON.parse(run.stdout).hookSpecificOutput.permissionDecisionReason ?? '' }
  } catch {
    return { decision: 'error', detail: `出力を読めません：${run.stdout}` }
  }
  return { decision: 'allow', detail: '' }
}

// テストケースを実行する。
//   - 共通リスト（guards.default.test.json）は、空のリポジトリと空の user 側の設定で確かめる（利用者のガードや除外に左右されない）
//   - start が self-improve の動くリポジトリなら、そこで効く 3 か所のテストケースも、実際の設定のまま確かめる：
//     ~/.claude/self-improve/guards.test.json、~/.claude/self-improve/repos/<名前>/guards.test.json、harness/guards.test.json
export function runGuardTests(start) {
  const scratch = mkdtempSync(join(tmpdir(), 'self-improve-guards-'))
  try {
    const results = []
    const errors = []
    const runSuite = (source, tests, root, env) => {
      if (!Array.isArray(tests)) {
        errors.push(`${source} を読めません（テストケースの配列にしてください）`)
        return
      }
      for (const test of tests) {
        if (!test || !test.tool || !['deny', 'ask', 'allow'].includes(test.expect)) {
          errors.push(`${source} の「${test?.name ?? '（名前なし）'}」：tool と expect（deny / ask / allow）が必要です`)
          continue
        }
        const actual = decide(root, join(scratch, 'data'), test, env)
        results.push({ source, name: test.name ?? '', expect: test.expect, actual: actual.decision, detail: actual.detail, ok: actual.decision === test.expect })
      }
    }

    const blank = join(scratch, 'repo')
    const home = join(scratch, 'home')
    mkdirSync(join(blank, '.git'), { recursive: true })
    mkdirSync(join(home, '.claude'), { recursive: true })
    runSuite('guards.default.test.json', readJson(DEFAULT_TESTS, null), blank, { HOME: home, HARNESS_CLAUDE_HOME: join(home, '.claude') })

    const ctx = makeContext(start)
    if (ctx) {
      const own = [
        [join(ctx.user.dir, 'guards.test.json'), tildePath(join(ctx.user.dir, 'guards.test.json'))],
        [join(ctx.user.repoDir, 'guards.test.json'), tildePath(join(ctx.user.repoDir, 'guards.test.json'))],
        [join(ctx.repo.root, 'harness', 'guards.test.json'), 'harness/guards.test.json'],
      ]
      for (const [file, label] of own) {
        if (existsSync(file)) runSuite(label, readJson(file, null), ctx.repo.root, {})
      }
    }
    return { ok: errors.length === 0 && results.every((r) => r.ok), repo: ctx ? ctx.repo.name : null, results, errors }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const result = runGuardTests(args.find((a) => !a.startsWith('--')) || process.cwd())
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    for (const r of result.results) {
      process.stdout.write(`${r.ok ? 'OK' : 'NG'}  [${r.source}] ${r.name}（期待 ${r.expect}${r.ok ? '' : `、実際 ${r.actual}${r.detail ? `：${r.detail}` : ''}`}）\n`)
    }
    for (const e of result.errors) process.stdout.write(`NG  ${e}\n`)
    const failed = result.results.filter((r) => !r.ok).length + result.errors.length
    process.stdout.write(`${result.results.length} 件中 ${result.results.length - result.results.filter((r) => !r.ok).length} 件が期待どおり${failed ? `、問題 ${failed} 件` : ''}。${result.repo ? '' : '（self-improve の動くリポジトリではないので、共通リストだけを実行しました）'}\n`)
  }
  process.exitCode = result.ok ? 0 : 1
}
