import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { exportHelp, nextId, parseMarkdown, parseYamlSubset, runCheck, status } from '../scripts/check.mjs'
import { ACTORS, design, feature, makeRepo, req, writeFiles } from './helpers.mjs'

const rules = (result) => result.findings.filter((f) => f.level === 'error').map((f) => `${f.file}:${f.rule}`)
const hasError = (result, file, rule) => rules(result).includes(`${file}:${rule}`)

test('YAML: マップ・リスト・フロー・引用符・ブロック・コメントを読む', () => {
  const data = parseYamlSubset(`# 先頭のコメント
id: F-012
tags: [a, "b, c", 'd''e']
empty: []
url: https://example.com/a#b   # ここはコメント
nested:
  list:
    - x
    - k: v
      k2: v2
  seq_same_indent:
  - 1
  - true
text: |
  一行目
  二行目
folded: >-
  あ
  い

  う
quoted: "# ハッシュ"
none:
`)
  assert.deepEqual(data, {
    id: 'F-012',
    tags: ['a', 'b, c', "d'e"],
    empty: [],
    url: 'https://example.com/a#b',
    nested: { list: ['x', { k: 'v', k2: 'v2' }], seq_same_indent: [1, true] },
    text: '一行目\n二行目\n',
    folded: 'あ い\nう',
    quoted: '# ハッシュ',
    none: null,
  })
})

test('YAML: 対応していない書き方は行番号つきで落とす', () => {
  const cases = {
    'a: 1\n  b: 2': /2 行目/,
    'a:\n\t- x': /タブ/,
    'a: [1, 2': /閉じて/,
    'a: 1\na: 2': /重複/,
    'a: {x: 1}': /フローのマップ/,
    'a: *ref': /アンカー/,
    '- a\n  b': /続きの行/,
  }
  for (const [text, message] of Object.entries(cases)) assert.throws(() => parseYamlSubset(text), message, text)
})

test('Markdown: フロントマターと、コードブロックの外の ## 見出しを読む', () => {
  const doc = parseMarkdown(design({ pending: ['REQ-0001'] }))
  assert.deepEqual(doc.data, { feature: 'F-001', pending: ['REQ-0001'] })
  assert.deepEqual(doc.headings, ['要件（EARS）', '受け入れ条件'])
})

test('空のリポジトリは問題なし', () => {
  const result = runCheck(makeRepo())
  assert.equal(result.ok, true)
  assert.deepEqual(result.counts, { requirements: 0, designs: 0, features: 0 })
})

test('draft は形だけ調べる', () => {
  const repo = makeRepo({ 'actors.yaml': ACTORS, 'docs/requirements/REQ-0001-fav.md': req({ status: 'draft', sections: [] }) })
  assert.equal(runCheck(repo).ok, true)
})

test('approved: 節・既存の機能・アクターを調べる', () => {
  const repo = makeRepo({
    'actors.yaml': ACTORS,
    'docs/requirements/REQ-0001-fav.md': req({ sections: ['背景と課題'], changed: ['F-009'], actors: ['A-nobody'] }),
  })
  const result = runCheck(repo)
  assert.ok(hasError(result, 'docs/requirements/REQ-0001-fav.md', 'sections'))
  assert.ok(hasError(result, 'docs/requirements/REQ-0001-fav.md', 'features'))
  assert.ok(hasError(result, 'docs/requirements/REQ-0001-fav.md', 'actors'))
})

test('approved: 正しければ通る。新規の機能が機能マスタにあると落とす', () => {
  const repo = makeRepo({ 'actors.yaml': ACTORS, 'docs/requirements/REQ-0001-fav.md': req() })
  assert.equal(runCheck(repo).ok, true)
  writeFiles(repo, { 'features/F-001-fav.yaml': feature() })
  assert.ok(hasError(runCheck(repo), 'docs/requirements/REQ-0001-fav.md', 'features'))
})

test('新しいアクターは implemented になるまで actors.yaml になくてよい', () => {
  const extra = 'new_actors:\n  - id: A-guest\n    name: ゲスト\n    kind: human\n'
  const repo = makeRepo({ 'actors.yaml': ACTORS, 'docs/requirements/REQ-0001-fav.md': req({ actors: ['A-guest'], extra }) })
  assert.equal(runCheck(repo).ok, true)
})

test('designed: 設計書の pending と UI 案を求める', () => {
  const repo = makeRepo({ 'actors.yaml': ACTORS, 'docs/requirements/REQ-0001-fav.md': req({ status: 'designed' }) })
  let result = runCheck(repo)
  assert.ok(hasError(result, 'docs/requirements/REQ-0001-fav.md', 'design'))
  assert.ok(hasError(result, 'docs/requirements/REQ-0001-fav.md', 'ui'))

  writeFiles(repo, { 'docs/design/F-001-fav.md': design(), 'docs/ui/REQ-0001/index.html': '<html></html>' })
  result = runCheck(repo)
  assert.ok(hasError(result, 'docs/design/F-001-fav.md', 'pending'))

  writeFiles(repo, { 'docs/design/F-001-fav.md': design({ pending: ['REQ-0001'] }) })
  assert.equal(runCheck(repo).ok, true)
})

test('designed で画面が変わらないなら ui: none', () => {
  const repo = makeRepo({
    'actors.yaml': ACTORS,
    'docs/requirements/REQ-0001-fav.md': req({ status: 'designed', ui: 'none' }),
    'docs/design/F-001-fav.md': design({ pending: ['REQ-0001'] }),
  })
  assert.equal(runCheck(repo).ok, true)
})

test('設計書: pending の REQ が designed でないと落とす。機能が見つからない設計書も落とす', () => {
  const repo = makeRepo({
    'actors.yaml': ACTORS,
    'docs/requirements/REQ-0001-fav.md': req({ status: 'approved' }),
    'docs/design/F-001-fav.md': design({ pending: ['REQ-0001'] }),
    'docs/design/F-777-ghost.md': design({ feature: 'F-777' }),
  })
  const result = runCheck(repo)
  assert.ok(hasError(result, 'docs/design/F-001-fav.md', 'pending'))
  assert.ok(hasError(result, 'docs/design/F-777-ghost.md', 'feature'))
})

test('implemented: 機能マスタへの反映と pending の外し忘れを調べる', () => {
  const repo = makeRepo({
    'actors.yaml': ACTORS,
    'docs/requirements/REQ-0001-fav.md': req({ status: 'implemented', ui: 'none' }),
    'docs/design/F-001-fav.md': design({ pending: ['REQ-0001'] }),
  })
  let result = runCheck(repo)
  assert.ok(hasError(result, 'docs/requirements/REQ-0001-fav.md', 'features'))
  assert.ok(hasError(result, 'docs/design/F-001-fav.md', 'pending'))

  writeFiles(repo, { 'features/F-001-fav.yaml': feature({ requirements: [] , extra: 'legacy: false\n' }) })
  result = runCheck(repo)
  assert.ok(hasError(result, 'features/F-001-fav.yaml', 'requirements'))

  writeFiles(repo, { 'features/F-001-fav.yaml': feature(), 'docs/design/F-001-fav.md': design() })
  assert.deepEqual(rules(runCheck(repo)), [])
})

function implementedRepo(extraFiles = {}) {
  return makeRepo({
    'actors.yaml': ACTORS,
    'docs/requirements/REQ-0001-fav.md': req({ status: 'implemented', ui: 'none' }),
    'docs/design/F-001-fav.md': design(),
    'features/F-001-fav.yaml': feature(),
    ...extraFiles,
  })
}

test('機能マスタ: 裏側の項目・planned・ga のヘルプ項目を調べる', () => {
  const file = 'features/F-001-fav.yaml'
  let repo = implementedRepo({ [file]: feature({ extra: 'api:\n  - POST /favorites\n' }) })
  assert.ok(hasError(runCheck(repo), file, 'internal'))

  repo = implementedRepo({ [file]: feature({ status: 'planned' }) })
  assert.ok(hasError(runCheck(repo), file, 'status'))

  repo = implementedRepo({ [file]: feature({ help: false }) })
  const result = runCheck(repo)
  assert.ok(hasError(result, file, 'help'))
  assert.ok(hasError(result, file, 'changelog'))
  assert.ok(hasError(result, file, 'last_reviewed'))

  repo = implementedRepo({ [file]: feature({ status: 'beta', help: false }) })
  assert.equal(runCheck(repo).ok, true)
})

test('機能マスタ: deprecated は終了日と代わりの手段を求める', () => {
  const file = 'features/F-001-fav.yaml'
  const repo = implementedRepo({ [file]: feature({ status: 'deprecated' }) })
  assert.ok(hasError(runCheck(repo), file, 'deprecated'))
  writeFiles(repo, { [file]: feature({ status: 'deprecated', extra: 'deprecated_at: 2026-12-01\nalternative: なし\n' }) })
  assert.equal(runCheck(repo).ok, true)
})

test('機能マスタ: legacy は要件定義書がなくてよく、設計書がなければ警告だけ', () => {
  const repo = makeRepo({ 'actors.yaml': ACTORS, 'features/F-001-fav.yaml': feature({ requirements: [], extra: 'legacy: true\n' }) })
  const result = runCheck(repo)
  assert.equal(result.ok, true)
  assert.equal(result.warnings, 1)
})

test('ID とファイル名のずれ、読めない YAML を落とす', () => {
  const repo = makeRepo({
    'actors.yaml': ACTORS,
    'features/F-002-fav.yaml': feature({ id: 'F-001', requirements: [], extra: 'legacy: true\n' }),
    'features/F-003-bad.yaml': 'id: F-003\n  name: x\n',
    'features/fav.yaml': 'id: x\n',
  })
  const result = runCheck(repo)
  assert.ok(hasError(result, 'features/F-002-fav.yaml', 'id'))
  assert.ok(hasError(result, 'features/F-003-bad.yaml', 'parse'))
  assert.ok(hasError(result, 'features/fav.yaml', 'filename'))
})

test('next-id は機能マスタ・設計書・要件定義書の新規の ID をすべて数える', () => {
  const repo = makeRepo({ 'actors.yaml': ACTORS, 'docs/requirements/REQ-0007-fav.md': req({ id: 'REQ-0007', newF: ['F-014'] }), 'features/F-003-x.yaml': 'id: F-003\n' })
  assert.equal(nextId(repo, 'req'), 'REQ-0008')
  assert.equal(nextId(repo, 'feature'), 'F-015')
  assert.equal(nextId(makeRepo(), 'req'), 'REQ-0001')
  assert.equal(nextId(makeRepo(), 'feature'), 'F-001')
})

test('status は要件定義書の段階と次にやることを出す', () => {
  const repo = makeRepo({ 'actors.yaml': ACTORS, 'docs/requirements/REQ-0001-fav.md': req({ status: 'designed' }), 'docs/design/F-001-fav.md': design({ pending: ['REQ-0001'] }) })
  const s = status(repo)
  assert.equal(s.requirements[0].status, 'designed')
  assert.match(s.requirements[0].next, /build/)
  assert.deepEqual(s.pending_designs, [{ feature: 'F-001', pending: ['REQ-0001'], file: 'docs/design/F-001-fav.md' }])
})

test('export-help: 公開の機能だけを、許可した項目だけで書き出す', () => {
  const repo = implementedRepo({
    'docs/requirements/REQ-0002-x.md': req({ id: 'REQ-0002', status: 'implemented', newF: ['F-002'], ui: 'none' }),
    'docs/design/F-002-x.md': design({ feature: 'F-002' }),
    'features/F-002-x.yaml': feature({ id: 'F-002', requirements: ['REQ-0002'] }).replace('visibility: public', 'visibility: internal'),
    'glossary.yaml': 'terms:\n  - term: fav\n    user_facing: お気に入り\n    synonyms: [ブックマーク]\n    description: 保存した投稿\n    public: true\n  - term: 社内だけ\n    description: x\n',
  })
  const result = exportHelp(repo)
  assert.equal(result.ok, true)
  const out = join(repo, 'docs/generated/help')
  const md = readFileSync(join(out, 'F-001.md'), 'utf8')
  assert.match(md, /^---\nid: "F-001"/)
  assert.match(md, /## 使い方\n\n1\. ハートをタップします/)
  assert.match(md, /## できないこと・制限\n\n- フォルダ分けはできません\n- 500件まで/)
  assert.match(md, /圏外のとき: あとで反映される/)
  assert.match(md, /## よくある質問: オフラインでも保存できますか？/)
  assert.doesNotMatch(md, /REQ-0001|design|要件（EARS）/)
  assert.equal(existsSync(join(out, 'F-002.md')), false)
  assert.deepEqual(result.skipped, [{ id: 'F-002', reason: 'help.visibility が public ではない' }])
  const glossary = readFileSync(join(out, 'glossary.md'), 'utf8')
  assert.match(glossary, /## お気に入り/)
  assert.doesNotMatch(glossary, /社内だけ/)
  const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'))
  assert.deepEqual(index.features.map((f) => f.id), ['F-001'])

  // 機能がなくなったら、前の書き出しも消える
  rmSync(join(repo, 'features/F-001-fav.yaml'))
  rmSync(join(repo, 'docs/requirements/REQ-0001-fav.md'))
  rmSync(join(repo, 'docs/design/F-001-fav.md'))
  exportHelp(repo)
  assert.equal(existsSync(join(out, 'F-001.md')), false)
})

test('export-help: 誤りがあれば書き出さない（--force で書き出す）', () => {
  const repo = implementedRepo({ 'features/F-001-fav.yaml': feature({ extra: 'api: x\n' }) })
  assert.equal(exportHelp(repo).ok, false)
  assert.equal(existsSync(join(repo, 'docs/generated/help/F-001.md')), false)
  assert.equal(exportHelp(repo, { force: true }).ok, true)
  assert.doesNotMatch(readFileSync(join(repo, 'docs/generated/help/F-001.md'), 'utf8'), /api/)
})

test('設定で置き場所を変えられる', () => {
  const repo = makeRepo({
    'feature-docs/config.json': JSON.stringify({ paths: { features: 'spec/features', actors: 'spec/actors.yaml' } }),
    'spec/actors.yaml': ACTORS,
    'spec/features/F-001-fav.yaml': feature({ requirements: [], extra: 'legacy: true\n' }),
  })
  const result = runCheck(repo)
  assert.equal(result.counts.features, 1)
  assert.equal(result.ok, true)
})
