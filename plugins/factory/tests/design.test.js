import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDesignSystem, parseComponentCandidates } from '../line/design.js'

function repoWith(json) {
  const repo = mkdtempSync(join(tmpdir(), 'factory-design-'))
  if (json) {
    mkdirSync(join(repo, 'design-system'))
    writeFileSync(join(repo, 'design-system', 'design-system.json'), JSON.stringify(json))
  }
  return repo
}

test('no design-system.json means no design system', () => {
  assert.equal(loadDesignSystem(repoWith(null)), null)
})

test('the design system brings its docs, protected paths and check command', () => {
  const ds = loadDesignSystem(
    repoWith({
      docs: ['design-system/README.md', 'design-system/copy.md', 'design-system/patterns.md'],
      protected_paths: ['design-system/**', 'App/DesignSystem/**'],
      check: { command: 'node design-system/check.mjs' },
    }),
  )
  assert.deepEqual(ds.docs, ['design-system/README.md', 'design-system/copy.md', 'design-system/patterns.md'])
  assert.deepEqual(ds.protected_paths, ['design-system/**', 'App/DesignSystem/**'])
  assert.equal(ds.check, 'node design-system/check.mjs')
  assert.deepEqual(ds.copyDocs, ['design-system/copy.md', 'design-system/patterns.md'])
})

test('missing fields fall back to empty lists and no check', () => {
  const ds = loadDesignSystem(repoWith({}))
  assert.deepEqual(ds.docs, [])
  assert.deepEqual(ds.protected_paths, [])
  assert.equal(ds.check, null)
})

test('component candidates are read from the implementer report', () => {
  const report = '実装しました。\n\n## 部品の候補\n\n- 文字数の表示（入力欄の右下に小さく）\n- 確認つきの削除ボタン\n\n## テスト\n- 通過\n'
  assert.deepEqual(parseComponentCandidates(report), ['文字数の表示（入力欄の右下に小さく）', '確認つきの削除ボタン'])
  assert.deepEqual(parseComponentCandidates('## 部品の候補\n\nなし\n'), [])
  assert.deepEqual(parseComponentCandidates('候補の見出しがない報告'), [])
})
