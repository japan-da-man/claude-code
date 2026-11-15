// ガードを入力 JSON でテストする。エージェントも実際のコマンドも動かさない。
// hook の入力 JSON を guard-harness.mjs に直接渡し、deny / ask / allow のどれになったかを期待と比べる。
//
//   node test-guards.mjs [リポジトリのパス] [--json]
//
// 実行するのは、共通リストのテスト（guards.default.test.json）と、リポジトリの harness/guards.test.json。
// init していない場所では、一時的なリポジトリで共通リストのテストだけを実行する。
// テストケースの形：{ "name": "...", "tool": "Bash", "input": { "command": "..." }, "expect": "deny" | "ask" | "allow" }
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLUGIN_ROOT, findRepo, isMain, loadConfig, readJson } from './lib/core.mjs'

const GUARD = join(PLUGIN_ROOT, 'scripts', 'guard-harness.mjs')
export const DEFAULT_TESTS = join(PLUGIN_ROOT, 'guards.default.test.json')

export function decide(repoRoot, dataDir, test) {
  const input = { session_id: 'test-guards', cwd: repoRoot, hook_event_name: 'PreToolUse', tool_name: test.tool, tool_input: test.input ?? {} }
  const env = { ...process.env, HARNESS_GUARD_DRYRUN: '1', HARNESS_DATA_DIR: dataDir }
  delete env.HARNESS_DISABLE
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

export function runGuardTests(start) {
  const scratch = mkdtempSync(join(tmpdir(), 'self-improve-guards-'))
  try {
    const found = findRepo(start)
    const initialized = Boolean(found && loadConfig(found.root))
    let root = found?.root
    if (!initialized) {
      root = join(scratch, 'repo')
      mkdirSync(join(root, '.git'), { recursive: true })
      mkdirSync(join(root, 'harness'), { recursive: true })
      writeFileSync(join(root, 'harness', 'config.json'), '{}\n')
    }
    const suites = [{ source: 'guards.default.test.json', tests: readJson(DEFAULT_TESTS, null) }]
    if (initialized) suites.push({ source: 'harness/guards.test.json', tests: readJson(join(root, 'harness', 'guards.test.json'), []) })
    const results = []
    const errors = []
    for (const suite of suites) {
      if (!Array.isArray(suite.tests)) {
        errors.push(`${suite.source} を読めません（テストケースの配列にしてください）`)
        continue
      }
      for (const test of suite.tests) {
        if (!test || !test.tool || !['deny', 'ask', 'allow'].includes(test.expect)) {
          errors.push(`${suite.source} の「${test?.name ?? '（名前なし）'}」：tool と expect（deny / ask / allow）が必要です`)
          continue
        }
        const actual = decide(root, join(scratch, 'data'), test)
        results.push({ source: suite.source, name: test.name ?? '', expect: test.expect, actual: actual.decision, detail: actual.detail, ok: actual.decision === test.expect })
      }
    }
    return { ok: errors.length === 0 && results.every((r) => r.ok), initialized, results, errors }
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
    process.stdout.write(`${result.results.length} 件中 ${result.results.length - result.results.filter((r) => !r.ok).length} 件が期待どおり${failed ? `、問題 ${failed} 件` : ''}。${result.initialized ? '' : '（init していない場所なので、共通リストだけを実行しました）'}\n`)
  }
  process.exitCode = result.ok ? 0 : 1
}
