// Claude の Design System への写し（artifact-stage・artifact-done）と、写した中身が古くなったときの知らせ。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCheck } from '../scripts/check.mjs'
import { artifactDone, artifactStage, install, toDesignSystemTokens } from '../scripts/cli.mjs'
import { tempRepo } from './helpers.mjs'

const fresh = (base = 'hig') => {
  const repo = tempRepo({ 'README.md': '# app\n' })
  install(repo, { base })
  return repo
}
const stageDir = () => mkdtempSync(join(tmpdir(), 'product-design-stage-'))
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'))

test('artifact-stage lays out the system under project/ with converted tokens, sections and one card per component', () => {
  const repo = fresh('hig')
  const dir = stageDir()
  const r = artifactStage(repo, dir, { title: 'Memo', by: 'Hanako', now: '2026-10-30T00:00:00Z' })
  assert.equal(r.root, dir)
  assert.equal(r.file_path, join(dir, 'project/design-system.json'))
  for (const p of ['project/tokens.json', 'project/tokens.css', 'project/README.md', 'project/product-principles.md', 'project/principles.md', 'project/foundations.md', 'project/patterns.md', 'project/copy.md', 'project/components/bundle.css', 'project/components/Button/README.md', 'project/components/Button/preview.html', 'project/components/AlertDialog/preview.html']) {
    assert.equal(r.files[p], p, p)
    assert.ok(existsSync(join(dir, p)), p)
  }
  assert.equal(r.files['project/design-system.json'], undefined, '索引は file_path で別に送る')
  assert.equal(Object.keys(r.files).filter((p) => p.endsWith('/preview.html')).length, 18)
  for (const p of Object.keys(r.files)) assert.doesNotMatch(p, /\.\.|^\/|\\/)

  const config = readJson(join(repo, 'design-system/design-system.json'))
  assert.deepEqual(readJson(join(dir, 'project/tokens.json')), toDesignSystemTokens(readJson(join(repo, 'design-system/tokens.json')), { title: 'Memo', ...config }))
})

test('a preview is the page body with the card marker, and its README leads with the purpose', () => {
  const repo = fresh('shadcn')
  const dir = stageDir()
  artifactStage(repo, dir, { title: 'Memo' })
  const preview = readFileSync(join(dir, 'project/components/Button/preview.html'), 'utf8')
  assert.match(preview.split('\n')[0], /^<!-- @dsCard group="操作" height=\d+ -->$/)
  assert.match(preview, /<main class="ds-page">/)
  assert.match(preview, /ds-button--default/)
  assert.doesNotMatch(preview, /<link|<script|<html|<head/)
  const readme = readFileSync(join(dir, 'project/components/Button/README.md'), 'utf8')
  assert.match(readme, /^# ボタン\n\n操作を実行する。\n/)
  assert.doesNotMatch(readme, /^(?:name|status|from|outputs):/m)
  assert.match(readme, /design-system\/components\/button\.md/)
})

test('tokens.css carries the type header, the token variables and a class per text style; bundle.css has the components', () => {
  const repo = fresh('hig')
  const dir = stageDir()
  artifactStage(repo, dir, { title: 'Memo' })
  const css = readFileSync(join(dir, 'project/tokens.css'), 'utf8')
  assert.equal(css.split('\n')[0], '/* Memo — generated from tokens.json */')
  assert.match(css, /--tint: #0064d2;/)
  assert.match(css, /--font-system: system-ui, -apple-system, sans-serif;/)
  assert.match(css, /\.headline \{ font: var\(--font-headline\); letter-spacing: var\(--letter-spacing-headline\); \}/)
  const bundle = readFileSync(join(dir, 'project/components/bundle.css'), 'utf8')
  assert.match(bundle, /\.ds-button \{/)
  assert.match(bundle, /\.ds-page \{/)
  assert.doesNotMatch(bundle, /--tint:/)
  assert.doesNotMatch(bundle, /<\/style/i)
})

test('the README adds the rules for Claude Design and says the repository is the source', () => {
  const repo = fresh('hig')
  const dir = stageDir()
  artifactStage(repo, dir, { title: 'Memo' })
  const readme = readFileSync(join(dir, 'project/README.md'), 'utf8')
  assert.match(readme, /## Claude Design で案を作るときの決まり/)
  assert.match(readme, /部品の候補/)
  assert.match(readme, /\/product-design:update/)
})

test('a new index is read-only and synced from code; an existing one keeps its keys and title', () => {
  const repo = fresh('hig')
  const dir = stageDir()
  artifactStage(repo, dir, { title: 'Memo', by: 'Hanako', now: '2026-10-30T00:00:00Z' })
  const index = readJson(join(dir, 'project/design-system.json'))
  assert.equal(index.v, 3)
  assert.equal(index.layout, 'files')
  assert.deepEqual(index.createdOnFiles, { v: 1, at: '2026-10-30T00:00:00Z' })
  assert.equal(index.title, 'Memo')
  assert.equal(index.editing, 'code')
  assert.deepEqual(index.lastChange, { by: 'Hanako', at: '2026-10-30T00:00:00Z', via: 'product-design', note: 'design-system 1.0.0 を写した' })

  const old = join(dir, 'old-index.json')
  writeFileSync(old, JSON.stringify({ v: 3, layout: 'files', createdOnFiles: { v: 1, at: '2026-01-01T00:00:00Z' }, title: 'Old name', namespace: 'Old', assetGroups: { Logos: { name: 'Logos' } }, extra: 1 }))
  const again = stageDir()
  artifactStage(repo, again, { title: 'Memo', index: old, by: 'Hanako', now: '2026-10-31T00:00:00Z' })
  const merged = readJson(join(again, 'project/design-system.json'))
  assert.equal(merged.title, 'Old name')
  const again2 = stageDir()
  artifactStage(repo, again2, { index: old })
  assert.equal(readJson(join(again2, 'project/tokens.json')).name, 'Old name')
  assert.deepEqual(merged.createdOnFiles, { v: 1, at: '2026-01-01T00:00:00Z' })
  assert.deepEqual(merged.assetGroups, { Logos: { name: 'Logos' } })
  assert.equal(merged.extra, 1)
  assert.equal(merged.editing, 'code')
  assert.equal(merged.lastChange.at, '2026-10-31T00:00:00Z')
})

test('artifact-done records the url and hash, and a later change makes the Design System stale', () => {
  const repo = fresh('hig')
  const r = artifactDone(repo, 'https://claude.ai/artifact/abc')
  assert.equal(r.url, 'https://claude.ai/artifact/abc')
  assert.match(r.hash, /^[0-9a-f]{64}$/)
  assert.deepEqual(readJson(join(repo, 'design-system/design-system.json')).artifact, r)
  assert.deepEqual(runCheck(repo).stale, [])
  writeFileSync(join(repo, 'design-system/components/button.md'), readFileSync(join(repo, 'design-system/components/button.md'), 'utf8') + '\n追記\n')
  assert.match(runCheck(repo).stale.join('\n'), /Design System（https:\/\/claude\.ai\/artifact\/abc）に写した中身が古くなっています/)
})

test('artifact-stage refuses while tokens.json has errors', () => {
  const repo = fresh('hig')
  const file = join(repo, 'design-system/tokens.json')
  const root = readJson(file)
  delete root.color.label
  writeFileSync(file, JSON.stringify(root))
  assert.throws(() => artifactStage(repo, stageDir(), { title: 'Memo' }), /tokens\.json/)
})
