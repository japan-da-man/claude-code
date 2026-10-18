import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, loadConfig, mergeConfig } from '../line/config.js'

test('defaults fill what the project leaves out', () => {
  const c = mergeConfig({ type: 'ios', ios: { scheme: 'App' }, satisfaction: { threshold: 0.9 } })
  assert.equal(c.ios.scheme, 'App')
  assert.equal(c.satisfaction.threshold, 0.9)
  assert.equal(c.satisfaction.runs_per_scenario, 3)
  assert.equal(c.max_rounds, 5)
  assert.equal(c.models.implement, 'sonnet')
  assert.deepEqual(c.protected_paths, DEFAULTS.protected_paths)
})

test('a project list replaces the default list', () => {
  const c = mergeConfig({ type: 'ios', protected_paths: ['Secrets/**'] })
  assert.deepEqual(c.protected_paths, ['Secrets/**'])
})

test('bad values are rejected with the key name', () => {
  assert.throws(() => mergeConfig({ type: 'web' }), /type/)
  assert.throws(() => mergeConfig({ type: 'ios', satisfaction: { threshold: 2 } }), /threshold/)
  assert.throws(() => mergeConfig({ type: 'ios', max_rounds: 0 }), /max_rounds/)
  assert.throws(() => mergeConfig({ type: 'ios', satisfaction: { runs_per_scenario: 1.5 } }), /runs_per_scenario/)
})

test('loadConfig reads .factory/config.json from the repo', () => {
  const repo = mkdtempSync(join(tmpdir(), 'factory-config-'))
  mkdirSync(join(repo, '.factory'))
  writeFileSync(join(repo, '.factory', 'config.json'), JSON.stringify({ type: 'ios', ios: { scheme: 'Demo' } }))
  assert.equal(loadConfig(repo).ios.scheme, 'Demo')
})

test('loadConfig says to run init when the file is missing', () => {
  const repo = mkdtempSync(join(tmpdir(), 'factory-config-'))
  assert.throws(() => loadConfig(repo), /factory:init/)
})

test('Codex can judge but not implement, since it cannot be kept from the scenarios', () => {
  assert.equal(mergeConfig({ type: 'ios', models: { judge: 'codex' } }).models.judge, 'codex')
  assert.throws(() => mergeConfig({ type: 'ios', models: { implement: 'codex' } }), /models\.implement/)
})
