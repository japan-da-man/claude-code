import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkTrace, collectTrace, flattenTokens, parseFrontMatter, readCandidates, readPrinciples, readSections, traceFrom } from '../scripts/check.mjs'
import { config, minimalTokens, tempRepo, validRepoFiles } from './helpers.mjs'

const traceOf = (files) => {
  const all = { ...validRepoFiles(), ...files }
  const repo = tempRepo(all)
  const cfg = typeof all['design-system/design-system.json'] === 'string' ? JSON.parse(all['design-system/design-system.json']) : all['design-system/design-system.json']
  return collectTrace(repo, cfg, flattenTokens(all['design-system/tokens.json']).tokens)
}

test('front matter reads scalars, flow lists and maps, block lists and comments', () => {
  const { data, body } = parseFrontMatter('---\nname: button\nstatus: stable   # draft・stable・deprecated\nfrom: [D1, D3]\noutputs: { swiftui: DSButton, html: button }\nscreens:\n  - 設定画面\n  - "一覧, 詳細"\n---\n\n# ボタン\n')
  assert.deepEqual(data, { name: 'button', status: 'stable', from: ['D1', 'D3'], outputs: { swiftui: 'DSButton', html: 'button' }, screens: ['設定画面', '一覧, 詳細'] })
  assert.equal(body.trim(), '# ボタン')
  assert.equal(parseFrontMatter('# なし').data, null)
})

test('principles read IDs, the first line after the heading as the basis, and the retired section', () => {
  const { ids, errors } = readPrinciples('### D1 一つ\n\n根拠: P1, P2\n\n本文\n### D2 二つ\n本文\n## 廃止\n### D3 古い（廃止: 理由。置き換え: D1）\n根拠: P1\n', 'D')
  assert.deepEqual(errors, [])
  assert.deepEqual([...ids.keys()], ['D1', 'D2', 'D3'])
  assert.deepEqual(ids.get('D1').refs, ['P1', 'P2'])
  assert.equal(ids.get('D2').refs, null)
  assert.equal(ids.get('D3').retired, true)
  assert.match(readPrinciples('### D1 a\n### D1 b\n', 'D').errors[0], /D1 が 2 回/)
})

test('rule documents give each ## section its own basis, except the retired one', () => {
  const s = readSections('# 基礎\n\n## 色\n根拠: D1\n\n### 細かい話\n## 文字\n本文\n## 廃止\n')
  assert.deepEqual(s.map((x) => [x.title, x.refs]), [['色', ['D1']], ['文字', null]])
})

test('a fully linked repository has no trace errors', () => {
  const r = checkTrace(traceOf({}))
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.warnings, [])
})

test('missing, none and layer are errors; deprecated and orphan are warnings', () => {
  const tokens = minimalTokens('hig', { from: ['P1'] })
  const r = checkTrace(
    traceOf({
      'design-system/tokens.json': tokens,
      'docs/product/principles.md': '### P1 a\n### P2 b\n## 廃止\n### P3 c\n',
      'design-system/principles.md': '### D1 a\n根拠: P1, P3\n### D2 b\n根拠: P9\n### D3 c\n',
      'design-system/patterns.md': '## 一覧\n本文\n',
      'design-system/components/card.md': '---\nname: card\nstatus: draft\nfrom: [D1]\n---\n',
      'design-system/components/old.md': '---\nname: old\nstatus: deprecated\n---\n',
    }),
  )
  const errors = r.errors.join('\n')
  assert.match(errors, /trace-missing: design-system\/principles\.md:3 D2 が、実在しない P9/)
  assert.match(errors, /trace-none: design-system\/principles\.md:5 D3 に根拠がありません/)
  assert.match(errors, /trace-none: design-system\/patterns\.md:1 一覧 に根拠がありません/)
  assert.match(errors, /trace-layer: design-system\/tokens\.json color\.tint が P1 を指しています/)
  assert.doesNotMatch(errors, /components\/old/)
  assert.match(r.deprecated.join('\n'), /trace-deprecated: design-system\/principles\.md:1 D1 が、廃止された P3/)
  assert.match(r.warnings.join('\n'), /trace-orphan: P2/)
  assert.doesNotMatch(r.warnings.join('\n'), /P3/)
})

test('a component without front matter or with a bad status is an error', () => {
  const r = checkTrace(traceOf({ 'design-system/components/a.md': '# なし\n', 'design-system/components/b.md': '---\nname: b\nstatus: done\nfrom: [D1]\n---\n' }))
  const errors = r.errors.join('\n')
  assert.match(errors, /components\/a\.md: 先頭のメタデータ/)
  assert.match(errors, /components\/b\.md: status は draft・stable・deprecated/)
})

test('missing documents are reported instead of crashing', () => {
  const files = validRepoFiles()
  delete files['design-system/copy.md']
  delete files['docs/product/principles.md']
  const repo = tempRepo(files)
  const r = checkTrace(collectTrace(repo, config(), flattenTokens(files['design-system/tokens.json']).tokens))
  assert.match(r.errors.join('\n'), /docs\/product\/principles\.md がありません/)
  assert.match(r.errors.join('\n'), /design-system\/copy\.md がありません/)
})

test('trace --from walks down from a principle to tokens, rules and components', () => {
  const t = traceOf({})
  const hits = traceFrom(t, 'P1').map((h) => h.where)
  assert.ok(hits.some((w) => w.includes('principles.md:3 D1')))
  assert.ok(hits.some((w) => w.includes('color.tint')))
  assert.ok(hits.some((w) => w.includes('foundations.md:3 色')))
  const button = traceFrom(t, 'P1').find((h) => h.where.includes('button'))
  assert.deepEqual(button.outputs, { swiftui: 'DSButton', expo: 'Button', html: 'button' })
  assert.ok(traceFrom(t, 'primitive.space.4').some((h) => h.where.endsWith('space.1')))
})

test('candidates list the open ones with their screens and reject a bad status', () => {
  const repo = tempRepo({
    'docs/design-candidates/README.md': '# 候補の書き方\n',
    'docs/design-candidates/chip.md': '---\nstatus: open\nscreens: [SettingsView, ListView]\n---\n',
    'docs/design-candidates/rating.md': '---\nstatus: adopted\nscreens: [ReviewView]\n---\n',
    'docs/design-candidates/bad.md': '---\nstatus: maybe\n---\n',
    'docs/design-candidates/noscreens.md': '---\nstatus: exception\n---\n',
  })
  const r = readCandidates(repo, config())
  assert.deepEqual(r.open, [{ file: 'docs/design-candidates/chip.md', screens: ['SettingsView', 'ListView'] }])
  assert.equal(r.errors.length, 2)
})
