import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG, loadConfig } from '../scripts/lib/core.mjs'
import { ROOT, makeEnv, note, runHook, script, writeFiles } from './helpers.mjs'

const init = (t, dir = t.repo) => {
  const run = spawnSync(process.execPath, [script('init.mjs'), dir], { encoding: 'utf8', env: t.env })
  return { status: run.status, json: JSON.parse(run.stdout) }
}

test('init: harness/ を作り、.gitignore に追記する。2 回目は何も上書きしない', () => {
  const t = makeEnv({ initialized: false, files: { '.gitignore': 'node_modules' } })
  // init の前は、hook は何もしない
  const before = runHook('guard-harness.mjs', { session_id: 's', tool_name: 'Bash', tool_input: { command: 'git push --force' } }, t)
  assert.equal(before.status, 0)

  const first = init(t)
  assert.equal(first.status, 0)
  assert.deepEqual(first.json.created, ['harness/config.json', 'harness/guards.json', 'harness/guards.test.json', 'harness/incidents/.gitkeep', '.gitignore'])
  assert.deepEqual(first.json.skipped, [])
  assert.equal(first.json.allow_rule, 'Bash(harness-note *)')
  assert.equal(first.json.allow_rule_present, false)
  assert.equal(readFileSync(join(t.repo, '.gitignore'), 'utf8'), 'node_modules\n# self-improve: 棚卸しのレポート\nharness/reports/\n')
  assert.deepEqual(readdirSync(join(t.repo, 'harness')).sort(), ['config.json', 'guards.json', 'guards.test.json', 'incidents'])
  // 許可ルールは書かない（.claude/settings.local.json は、確認を通して Claude が足す）
  assert.equal(existsSync(join(t.repo, '.claude')), false)

  // 置いた config.json は初期値と同じで、自動改善は止めてある
  const config = loadConfig(t.repo)
  assert.equal(config.error, null)
  assert.equal(config.auto.interval_days, 0)
  assert.deepEqual(JSON.parse(readFileSync(join(t.repo, 'harness/config.json'), 'utf8')), DEFAULT_CONFIG)
  assert.deepEqual(JSON.parse(readFileSync(join(t.repo, 'harness/guards.json'), 'utf8')), { disable_defaults: [], protect: [], rules: [] })

  // init のあとは、hook が動く
  const after = runHook('guard-harness.mjs', { session_id: 's', tool_name: 'Bash', tool_input: { command: 'git push --force' } }, t)
  assert.equal(after.status, 2)
  assert.equal(note(t, ['keys']).status, 0)

  writeFiles(t.repo, { 'harness/config.json': { auto: { interval_days: 7 } }, '.claude/settings.local.json': { permissions: { allow: ['Bash(harness-note *)'] } } })
  const second = init(t)
  assert.deepEqual(second.json.created, [])
  assert.deepEqual(second.json.skipped, ['harness/config.json', 'harness/guards.json', 'harness/guards.test.json', '.gitignore'])
  assert.equal(second.json.allow_rule_present, true)
  assert.equal(loadConfig(t.repo).auto.interval_days, 7)
})

test('init: git リポジトリでなければ、何も作らない', () => {
  const t = makeEnv({ initialized: false })
  const run = init(t, t.base)
  assert.equal(run.status, 1)
  assert.equal(run.json.ok, false)
  assert.equal(existsSync(join(t.base, 'harness')), false)
})

test('templates: config.json は設計書の初期値どおり。失敗票のひな形は 4 見出し', () => {
  assert.deepEqual(JSON.parse(readFileSync(join(ROOT, 'templates/config.json'), 'utf8')), DEFAULT_CONFIG)
  const incident = readFileSync(join(ROOT, 'templates/incident.md'), 'utf8')
  for (const key of ['id', 'date', 'area', 'category', 'signal', 'root_cause', 'cause_key', 'related', 'severity', 'status', 'control', 'applied_by', 'trial_started_at', 'promoted_at']) {
    assert.match(incident, new RegExp(`^${key}:`, 'm'), key)
  }
  for (const heading of ['## 何を頼んだか', '## 期待した結果', '## 実際の結果', '## 根拠']) assert.ok(incident.includes(heading))
})
