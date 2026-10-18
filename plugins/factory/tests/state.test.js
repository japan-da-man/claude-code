import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadState, saveState } from '../line/state.js'

const dir = () => mkdtempSync(join(tmpdir(), 'factory-state-'))

test('a new feature starts at round 1, implement step', () => {
  const s = loadState(dir(), { id: '20261018-one', repo: '/r/a' })
  assert.equal(s.round, 1)
  assert.equal(s.step, 'implement')
  assert.equal(s.status, 'running')
  assert.deepEqual(s.rounds, [])
})

test('saved state is read back so the line can resume', () => {
  const d = dir()
  const s = loadState(d, { id: '20261018-one', repo: '/r/a' })
  saveState(d, { ...s, round: 3, step: 'judge' })
  const again = loadState(d, { id: 'ignored', repo: 'ignored' })
  assert.equal(again.round, 3)
  assert.equal(again.step, 'judge')
  assert.equal(again.id, '20261018-one')
})

test('saving leaves no temp files behind', () => {
  const d = dir()
  saveState(d, loadState(d, { id: '20261018-one', repo: '/r/a' }))
  assert.deepEqual(readdirSync(d), ['state.json'])
})
