import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mockPaths, mockShoot, newFeature, resolveRepo, startLine, statusReport, submit, writeScenarios } from '../line/cli.js'
import { featureDir, projectHome } from '../line/paths.js'
import { acquireLock, listQueue } from '../line/queue.js'
import { saveState } from '../line/state.js'

const home = () => mkdtempSync(join(tmpdir(), 'factory-cli-'))

test('newFeature picks an id and makes its folders', () => {
  const h = home()
  const f = newFeature({ repo: '/r/memo', name: 'share memo', home: h, date: new Date(2026, 9, 18) })
  assert.equal(f.id, '20261018-share-memo')
  assert.equal(f.dir, featureDir(projectHome('/r/memo', h), f.id))
  assert.equal(f.spec, join(f.dir, 'spec.md'))
  assert.equal(f.scenarios, join(f.dir, 'scenarios'))
})

test('newFeature adds a suffix instead of reusing an existing id', () => {
  const h = home()
  const a = newFeature({ repo: '/r/memo', name: 'share', home: h, date: new Date(2026, 9, 18) })
  const b = newFeature({ repo: '/r/memo', name: 'share', home: h, date: new Date(2026, 9, 18) })
  assert.equal(a.id, '20261018-share')
  assert.equal(b.id, '20261018-share-2')
})

test('submit refuses a feature without spec or scenarios', () => {
  const h = home()
  const f = newFeature({ repo: '/r/memo', name: 'share', home: h })
  assert.throws(() => submit({ repo: '/r/memo', id: f.id, home: h, spawn: () => {} }), /spec\.md/)
  writeFileSync(f.spec, '# s\n')
  assert.throws(() => submit({ repo: '/r/memo', id: f.id, home: h, spawn: () => {} }), /シナリオ/)
})

test('submit queues the feature and starts the line only when none is running', () => {
  const h = home()
  const f = newFeature({ repo: '/r/memo', name: 'share', home: h })
  writeFileSync(f.spec, '# s\n')
  writeFileSync(join(f.scenarios, 'share-01.md'), '---\nid: share-01\n---\n')
  const started = []
  assert.equal(submit({ repo: '/r/memo', id: f.id, home: h, spawn: (cmd) => started.push(cmd) }).started, true)
  assert.deepEqual(listQueue(h).map((e) => e.id), [f.id])
  assert.equal(started.length, 1)

  acquireLock(h, process.pid)
  assert.equal(startLine({ home: h, spawn: (cmd) => started.push(cmd) }), false)
  assert.equal(started.length, 1)
})

test('status lists the line, the queue and every feature', () => {
  const h = home()
  const dir = featureDir(projectHome('/r/memo', h), '20261018-share')
  mkdirSync(dir, { recursive: true })
  saveState(dir, { id: '20261018-share', repo: '/r/memo', status: 'running', round: 2, step: 'verify', rounds: [{ round: 1, tests: true, score: 0.8 }], symptoms: [] })
  const r = statusReport(h)
  assert.equal(r.line.running, false)
  assert.deepEqual(r.queue, [])
  assert.deepEqual(r.features, [{ repo: '/r/memo', id: '20261018-share', status: 'running', round: 2, step: 'verify', lastScore: 0.8, pr: null }])
})

test('scenarios with Codex: writes only in the feature folder and passes the role, spec and repo', async () => {
  const h = home()
  const f = newFeature({ repo: '/r/memo', name: 'share', home: h })
  writeFileSync(f.spec, '# s\n')
  const calls = []
  const out = await writeScenarios({ repo: '/r/memo', id: f.id, home: h, model: 'codex', run: async (role) => (calls.push(role), { result: '| id | title | required |' }) })
  assert.equal(out, '| id | title | required |')
  const [role] = calls
  assert.equal(role.cwd, f.dir)
  assert.equal(role.sandbox, 'workspace-write')
  assert.equal(role.model, 'codex')
  assert.match(role.prompt, /シナリオ作成担当|受け入れシナリオ/)
  assert.ok(role.prompt.includes(f.spec))
  assert.ok(role.prompt.includes(f.scenarios))
  assert.ok(role.prompt.includes('/r/memo'))
  assert.doesNotMatch(role.prompt, /^---\nname:/)
})

test('scenarios refuses to run before the spec is written', async () => {
  const h = home()
  const f = newFeature({ repo: '/r/memo', name: 'share', home: h })
  await assert.rejects(writeScenarios({ repo: '/r/memo', id: f.id, home: h, model: 'codex', run: async () => ({ result: '' }) }), /spec\.md/)
})

test('mock-shoot waits for no one: it refuses while the line holds the simulator', () => {
  const h = home()
  acquireLock(h, process.pid)
  assert.throws(() => mockShoot({ repo: '/r/memo', id: '20261019-share', pages: ['factory-mock-a'], home: h }), /ライン/)
})

test('mock options and the chosen image live in separate folders, so only the choice reaches the branch', () => {
  const h = home()
  const f = newFeature({ repo: '/r/memo', name: 'share', home: h })
  const p = mockPaths({ repo: '/r/memo', id: f.id, home: h })
  assert.equal(p.options, join(f.dir, 'ui-options'))
  assert.equal(p.chosen, join(f.dir, 'ui'))
})

test('"." means the git repository the command runs in, so skills need no $(git rev-parse) substitution', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'factory-repo-')))
  execSync('git init -q', { cwd: repo })
  mkdirSync(join(repo, 'App', 'Sub'), { recursive: true })
  assert.equal(resolveRepo('.', join(repo, 'App', 'Sub')), repo)
  assert.equal(resolveRepo(undefined, repo), repo)
  assert.equal(resolveRepo('/some/where', repo), '/some/where')
  assert.throws(() => resolveRepo('.', realpathSync(mkdtempSync(join(tmpdir(), 'not-a-repo-')))), /git/)
})
