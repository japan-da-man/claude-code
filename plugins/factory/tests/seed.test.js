import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSeed, seedLaunchArgs } from '../line/seed.js'

const scenario = (pre) => `---\nid: a-01\ntitle: t\nrequired: true\n---\n## 前提\n${pre}\n\n## ユーザーの操作\n1. 開く\n`

test('a scenario without a factory-seed block has no seed', () => {
  assert.equal(parseSeed(scenario('- メモが 0 件')), null)
  // ふつうの json のブロックは、仕込むデータではない
  assert.equal(parseSeed(scenario('```json\n{"x":1}\n```')), null)
})

test('the factory-seed block is read and normalised to one line of JSON', () => {
  const s = parseSeed(scenario('- 古い版で保存したメモが 2 件ある\n\n```json factory-seed\n{\n  "memos": ["milk", "eggs"]\n}\n```'))
  assert.equal(s, '{"memos":["milk","eggs"]}')
})

test('broken seed JSON is an error that names the scenario', () => {
  assert.throws(() => parseSeed(scenario('```json factory-seed\n{memos: [}\n```'), 'a-01'), /a-01/)
})

test('the seed goes in base64, since a launch argument starting with { is read as a property list', () => {
  const args = seedLaunchArgs({ udid: 'U', bundleId: 'com.example.App', seed: '{"memos":[]}' })
  assert.deepEqual(args.slice(0, 5), ['simctl', 'launch', 'U', 'com.example.App', '-FactorySeed'])
  assert.equal(Buffer.from(args[5], 'base64').toString('utf8'), '{"memos":[]}')
  assert.doesNotMatch(args[5], /[{}"]/)
})
