import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UsageLimitError, buildArgs, parseUsageLimit, runClaude, withUsageWait } from '../line/claude.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url))
chmodSync(FAKE, 0o755)

function setup(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-claude-'))
  const log = join(dir, 'log.jsonl')
  return { dir, log, env: { ...process.env, FAKE_LOG: log, ...env }, calls: () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) }
}

test('implement role is locked out of the factory home', () => {
  const args = buildArgs({ model: 'sonnet', allowedTools: ['Edit', 'Bash(xcodebuild *)'], hide: '/Users/me/.factory' })
  assert.deepEqual(args.slice(0, 2), ['-p', '--output-format'])
  assert.ok(args.includes('dontAsk'))
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet')
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Edit,Bash(xcodebuild *)')
  const settings = JSON.parse(args[args.indexOf('--settings') + 1])
  assert.ok(settings.permissions.deny.includes('Read(//Users/me/.factory/**)'))
  assert.deepEqual(settings.sandbox.filesystem.denyRead, ['/Users/me/.factory'])
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false)
  assert.equal(settings.sandbox.failIfUnavailable, true)
})

test('verify and judge roles get the feature dir added instead', () => {
  const args = buildArgs({ model: 'opus', allowedTools: ['Read'], addDirs: ['/Users/me/.factory/p/id'] })
  assert.equal(args[args.indexOf('--add-dir') + 1], '/Users/me/.factory/p/id')
  assert.equal(args.includes('--settings'), false)
})

test('the prompt goes through stdin and the result comes back', async () => {
  const s = setup({ FAKE_RESULT: 'implemented' })
  const out = await runClaude({ bin: FAKE, cwd: s.dir, env: s.env, prompt: '仕様に沿って実装する', model: 'sonnet', allowedTools: ['Edit'] })
  assert.equal(out.result, 'implemented')
  const [call] = s.calls()
  assert.equal(call.stdin, '仕様に沿って実装する')
  assert.equal(call.args.includes('仕様に沿って実装する'), false)
})

test('a usage limit becomes an error that knows when to resume', async () => {
  const s = setup({ FAKE_MODE: 'limit', FAKE_RESET: '1790000000' })
  await assert.rejects(runClaude({ bin: FAKE, cwd: s.dir, env: s.env, prompt: 'x', model: 'opus', allowedTools: [] }), (e) => {
    assert.ok(e instanceof UsageLimitError)
    assert.equal(e.resetAt, 1790000000 * 1000)
    return true
  })
})

test('a crash is a normal error with stderr', async () => {
  const s = setup({ FAKE_MODE: 'crash' })
  await assert.rejects(runClaude({ bin: FAKE, cwd: s.dir, env: s.env, prompt: 'x', model: 'opus', allowedTools: [] }), /boom/)
})

test('usage limit messages are recognised in their known forms', () => {
  const now = 1_000_000
  assert.equal(parseUsageLimit('Claude AI usage limit reached|1790000000', now), 1790000000 * 1000)
  assert.equal(parseUsageLimit("You've hit your limit · resets 3pm", now), now + 30 * 60 * 1000)
  assert.equal(parseUsageLimit('some other error', now), null)
})

test('withUsageWait sleeps until the reset and tries again', async () => {
  const s = setup({ FAKE_MODE: 'limit,ok', FAKE_RESET: '2000', FAKE_COUNTER: join(mkdtempSync(join(tmpdir(), 'c-')), 'n') })
  const slept = []
  const paused = []
  const out = await withUsageWait(() => runClaude({ bin: FAKE, cwd: s.dir, env: s.env, prompt: 'x', model: 'opus', allowedTools: [] }), {
    now: () => 1_000_000,
    sleep: async (ms) => slept.push(ms),
    onPause: (until) => paused.push(until),
  })
  assert.equal(out.result, 'done')
  assert.deepEqual(paused, [2_000_000 + 60_000])
  assert.deepEqual(slept, [1_000_000 + 60_000])
})
