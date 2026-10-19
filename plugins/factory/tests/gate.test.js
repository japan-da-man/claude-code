import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildScriptChanges, changedLines, decideMerge, isTestFile, protectedChanges, summarize } from '../line/gate.js'

const run = (scenario, satisfied, { required = false, symptom = null } = {}) => ({ scenario, required, satisfied, symptom })

test('satisfaction is the mean of each scenario\'s share, so a scenario run once weighs as much as one run three times', () => {
  const s = summarize([run('a', false, { symptom: '保存されない' }), run('a', true), run('a', false, { symptom: '保存されない' }), run('b', true)])
  assert.equal(s.total, 4)
  assert.equal(s.satisfied, 2)
  assert.equal(s.score, (1 / 3 + 1) / 2)
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
  assert.deepEqual(decideMerge(good), { merge: true, reasons: [], stop: false })
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

test('reasons another round can fix keep the line going, reasons it cannot stop it', () => {
  const retry = decideMerge({ ...good, summary: { score: 0.5, requiredFailures: [] }, testsAdded: false, lintPassed: false })
  assert.equal(retry.stop, false)
  assert.equal(retry.reasons.length, 3)
  for (const over of [{ holdout: { score: 0.5, requiredFailures: [] } }, { holdout: { score: 1, requiredFailures: ['h'] } }, { mutantDetected: false }, { diffLines: 900, maxLines: 800 }, { ci: 'failure' }]) {
    const d = decideMerge({ ...good, ...over })
    assert.equal(d.merge, false, JSON.stringify(over))
    assert.equal(d.stop, true, JSON.stringify(over))
  }
  // 最終関門に合格し、壊したアプリを見つけ、上限以内ならマージ
  assert.equal(decideMerge({ ...good, holdout: { score: 1, requiredFailures: [] }, mutantDetected: true, diffLines: 800, maxLines: 800 }).merge, true)
})

test('scripts added to the build settings are found in the diff', () => {
  const diff = [
    'diff --git a/project.yml b/project.yml',
    '--- a/project.yml',
    '+++ b/project.yml',
    '@@ -1,2 +1,5 @@',
    ' targets:',
    '+    preBuildScripts:',
    '+      - script: cat ~/.factory/x',
    'diff --git a/App.xcodeproj/project.pbxproj b/App.xcodeproj/project.pbxproj',
    '+++ b/App.xcodeproj/project.pbxproj',
    '+\t\tisa = PBXShellScriptBuildPhase;',
    '+++ b/Package.swift',
    '+    plugins: [.plugin(name: "Leak")]',
    '+++ b/App/ContentView.swift',
    '+// preBuildScripts in a comment is fine here',
  ].join('\n')
  const hits = buildScriptChanges(diff)
  assert.deepEqual([...new Set(hits.map((h) => h.file))], ['project.yml', 'App.xcodeproj/project.pbxproj', 'Package.swift'])
  assert.deepEqual(buildScriptChanges('+++ b/project.yml\n+  sources: [App]\n'), [])
})

test('test files and changed lines are counted from git output', () => {
  assert.equal(isTestFile('MemoAppTests/MemoTests.swift'), true)
  assert.equal(isTestFile('Tests/Foo.swift'), true)
  assert.equal(isTestFile('App/LatestView.swift'), false)
  assert.equal(isTestFile('App/Contest.swift'), false)
  assert.equal(changedLines('10\t2\tApp/A.swift\n-\t-\tApp/icon.png\n3\t0\tB.swift\n'), 15)
})
