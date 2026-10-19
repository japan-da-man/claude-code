import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideMerge, protectedChanges, summarize } from '../line/gate.js'

const run = (scenario, satisfied, { required = false, symptom = null } = {}) => ({ scenario, required, satisfied, symptom })

test('satisfaction is the share of satisfied runs', () => {
  const s = summarize([run('a', true), run('a', true), run('a', false, { symptom: '保存されない' }), run('b', true)])
  assert.equal(s.total, 4)
  assert.equal(s.satisfied, 3)
  assert.equal(s.score, 0.75)
  assert.deepEqual(s.symptoms, ['保存されない'])
})

test('a required scenario must pass every run', () => {
  const s = summarize([run('a', true, { required: true }), run('a', false, { required: true, symptom: 'x' }), run('b', true)])
  assert.deepEqual(s.requiredFailures, ['a'])
})

test('the same symptom is passed on once', () => {
  const s = summarize([run('a', false, { symptom: '落ちる' }), run('b', false, { symptom: '落ちる' }), run('c', false)])
  assert.deepEqual(s.symptoms, ['落ちる'])
})

test('protected paths are matched against changed files', () => {
  const hits = protectedChanges(['App/App.entitlements', 'App/ContentView.swift', '.factory/config.json'], ['**/*.entitlements', '.factory/**'])
  assert.deepEqual(hits, ['App/App.entitlements', '.factory/config.json'])
})

const good = { summary: { score: 0.96, requiredFailures: [] }, threshold: 0.95, testsPassed: true, ci: 'none', protectedHits: [] }

test('merge only when every gate passes', () => {
  assert.deepEqual(decideMerge(good), { merge: true, reasons: [] })
})

test('each failing gate gives its own reason', () => {
  const d = decideMerge({ summary: { score: 0.9, requiredFailures: ['a'] }, threshold: 0.95, testsPassed: false, ci: 'failure', protectedHits: ['x.entitlements'] })
  assert.equal(d.merge, false)
  assert.equal(d.reasons.length, 5)
})

test('CI is waited for only when the repo has one', () => {
  assert.equal(decideMerge({ ...good, ci: 'success' }).merge, true)
  assert.equal(decideMerge({ ...good, ci: 'failure' }).merge, false)
})

test('a design system violation blocks the merge with its own reason', () => {
  const d = decideMerge({ summary: { score: 1, requiredFailures: [] }, threshold: 0.95, testsPassed: true, designPassed: false, ci: 'none', protectedHits: [] })
  assert.equal(d.merge, false)
  assert.match(d.reasons[0], /デザインシステム/)
  // デザインシステムのないアプリでは designPassed を渡さないので、条件にならない
  assert.equal(decideMerge({ summary: { score: 1, requiredFailures: [] }, threshold: 0.95, testsPassed: true, ci: 'none', protectedHits: [] }).merge, true)
})
