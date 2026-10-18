import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UsageLimitError } from '../line/claude.js'
import { buildCodexArgs, codexModel, isCodex, runCodex } from '../line/codex.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.js', import.meta.url))
chmodSync(FAKE, 0o755)

function setup(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-codex-'))
  const log = join(dir, 'log.jsonl')
  return { dir, env: { ...process.env, FAKE_LOG: log, ...env }, calls: () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) }
}

test('a model name starting with codex picks the Codex runner', () => {
  assert.equal(isCodex('codex'), true)
  assert.equal(isCodex('codex:gpt-6-astra'), true)
  assert.equal(isCodex('opus'), false)
  assert.equal(codexModel('codex'), null)
  assert.equal(codexModel('codex:gpt-6-astra'), 'gpt-6-astra')
})

test('args run headless in the given folder and sandbox, with the schema and output file', () => {
  const args = buildCodexArgs({ cwd: '/f', sandbox: 'read-only', model: 'codex:gpt-6-astra', schema: '/s.json', out: '/o.txt', addDirs: ['/x'] })
  assert.deepEqual(args, ['exec', '--sandbox', 'read-only', '-C', '/f', '--skip-git-repo-check', '--ephemeral', '-o', '/o.txt', '-m', 'gpt-6-astra', '--add-dir', '/x', '--output-schema', '/s.json'])
  const plain = buildCodexArgs({ cwd: '/f', sandbox: 'read-only', model: 'codex', out: '/o.txt' })
  assert.equal(plain.includes('-m'), false)
  assert.equal(plain.includes('--output-schema'), false)
})

test('the prompt goes through stdin and the last message comes back as the result', async () => {
  const s = setup({ FAKE_RESULT: '{"runs":[]}' })
  const out = await runCodex({ bin: FAKE, env: s.env, cwd: s.dir, sandbox: 'read-only', model: 'codex', prompt: '採点して' })
  assert.equal(out.result, '{"runs":[]}')
  const [call] = s.calls()
  assert.equal(call.stdin, '採点して')
  assert.equal(call.args.includes('採点して'), false)
})

test('a usage limit becomes a UsageLimitError so the line waits', async () => {
  const s = setup({ FAKE_MODE: 'limit' })
  await assert.rejects(runCodex({ bin: FAKE, env: s.env, cwd: s.dir, sandbox: 'read-only', model: 'codex', prompt: 'x' }), (e) => e instanceof UsageLimitError)
})

test('any other failure is a normal error with the output', async () => {
  const s = setup({ FAKE_MODE: 'crash' })
  await assert.rejects(runCodex({ bin: FAKE, env: s.env, cwd: s.dir, sandbox: 'read-only', model: 'codex', prompt: 'x' }), /boom/)
})
