import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJudgement, render } from '../line/prompts.js'

const implementVars = {
  spec: 'docs/factory/20261018-share-memo/spec.md',
  round: '2',
  symptoms: '- 共有したあと、相手側の一覧に新しいメモが出ない',
  build: 'xcodebuild build -project App.xcodeproj -scheme App',
  test: 'xcodebuild test -project App.xcodeproj -scheme App',
  protected: '- **/*.entitlements',
}

test('implement prompt names the spec and the symptoms but never the scenarios', () => {
  const text = render('implement', implementVars)
  assert.match(text, /docs\/factory\/20261018-share-memo\/spec\.md/)
  assert.match(text, /相手側の一覧/)
  assert.doesNotMatch(text, /scenario|シナリオ|\.factory\//i)
  assert.doesNotMatch(text, /\{\{/)
})

test('a missing variable is an error, not a blank', () => {
  assert.throws(() => render('implement', { ...implementVars, spec: undefined }), /spec/)
})

test('verify and judge prompts fill every placeholder', () => {
  const v = render('verify', { scenario: '/h/s/share-02.md', out: '/h/runs/1/share-02/1', bundle_id: 'com.example.App', device: 'iPhone 17' })
  assert.doesNotMatch(v, /\{\{/)
  const j = render('judge', { scenario: '/h/s/share-02.md', runs: '- /h/runs/1/share-02/1' })
  assert.doesNotMatch(j, /\{\{/)
})

test('judgement is read from a fenced json block in the answer', () => {
  const text = '見た結果です。\n```json\n[{"run": 1, "satisfied": true, "symptom": null}, {"run": 2, "satisfied": false, "symptom": "保存されない"}]\n```\n'
  assert.deepEqual(parseJudgement(text, 2), [
    { run: 1, satisfied: true, symptom: null },
    { run: 2, satisfied: false, symptom: '保存されない' },
  ])
})

test('a judgement with the wrong shape is rejected', () => {
  assert.throws(() => parseJudgement('[{"run": 1, "satisfied": "yes"}]', 1), /satisfied/)
  assert.throws(() => parseJudgement('[{"run": 1, "satisfied": true}]', 3), /3/)
  assert.throws(() => parseJudgement('no json here', 1), /JSON/)
})
