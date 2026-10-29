import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NS, colorModes, flattenTokens, resolveAlias, validateTokens } from '../scripts/check.mjs'
import { hex, minimalTokens } from './helpers.mjs'

const errorsOf = (root, base = 'hig') => validateTokens(root, base).errors

test('a token set with every required role passes', () => {
  assert.deepEqual(errorsOf(minimalTokens('hig')), [])
  assert.deepEqual(errorsOf(minimalTokens('shadcn'), 'shadcn'), [])
})

test('groups pass $type and from down; the primitive group is the base tier', () => {
  const { tokens } = flattenTokens(minimalTokens())
  assert.equal(tokens.get('space.2').type, 'dimension')
  assert.deepEqual(tokens.get('space.2').from, ['D1'])
  assert.equal(tokens.get('space.2').tier, 'semantic')
  assert.equal(tokens.get('primitive.space.4').tier, 'primitive')
  assert.equal(tokens.get('primitive.space.4').from, undefined)
})

test('a token own from replaces the group one', () => {
  const root = minimalTokens()
  root.color.label.$extensions = { [NS]: { from: ['D2'] } }
  assert.deepEqual(flattenTokens(root).tokens.get('color.label').from, ['D2'])
})

test('aliases resolve, and missing targets and cycles are errors', () => {
  const root = minimalTokens()
  root.color.tint = { $value: '{color.label}' }
  const { tokens } = flattenTokens(root)
  assert.equal(resolveAlias(tokens, '{color.tint}').token.path, 'color.label')

  const missing = minimalTokens()
  missing.color.tint = { $value: '{color.nothing}' }
  assert.match(errorsOf(missing).join('\n'), /参照先 \{color\.nothing\} がありません/)

  const loop = minimalTokens()
  loop.color.tint = { $value: '{color.label}' }
  loop.color.label = { $value: '{color.tint}' }
  assert.match(errorsOf(loop).join('\n'), /循環/)
})

test('values must have the DTCG shape for their type', () => {
  const root = minimalTokens()
  root.color.tint = { $value: '#0064d2' }
  root.radius.sm = { $value: '6px' }
  root.duration.fast = { $value: 150 }
  root.font.body.$value.lineHeight = { value: 22, unit: 'px' }
  const errors = errorsOf(root).join('\n')
  assert.match(errors, /"color\.tint": color は/)
  assert.match(errors, /"radius\.sm": dimension は/)
  assert.match(errors, /"duration\.fast": duration は/)
  assert.match(errors, /"font\.body": typography の lineHeight は/)
})

test('a missing required role, a bad name and a missing $type are errors', () => {
  const root = minimalTokens()
  delete root.color['secondary-label']
  root.color.Brand = { $value: hex('#0064d2') }
  root.custom = { thing: { $value: 1 } }
  const errors = errorsOf(root).join('\n')
  assert.match(errors, /必ずある役割 "color\.secondary-label" がありません/)
  assert.match(errors, /"color\.Brand" の名前は小文字の kebab-case/)
  assert.match(errors, /"custom\.thing" の \$type がありません/)
  assert.match(errorsOf(minimalTokens(), 'material').join('\n'), /base "material" は hig か shadcn/)
})

test('font tokens need a textStyle, and swiftui.system takes known names on colours only', () => {
  const root = minimalTokens()
  root.font.body.$extensions = {}
  root.color.label.$extensions = { [NS]: { swiftui: { system: 'labelColor' } } }
  root.radius.sm.$extensions = { [NS]: { swiftui: { system: 'label' } } }
  const errors = errorsOf(root).join('\n')
  assert.match(errors, /"font\.body": 文字のトークンには \$extensions の textStyle/)
  assert.match(errors, /"color\.label": swiftui\.system "labelColor" は書けない名前/)
  assert.match(errors, /"radius\.sm": swiftui\.system は色のトークンにだけ書けます/)
})

test('modes.dark is resolved and checked like the light value', () => {
  const root = minimalTokens()
  root.primitive.color = { $type: 'color', white: { $value: hex('#ffffff') } }
  root.color.label.$extensions = { [NS]: { modes: { dark: '{primitive.color.white}' } } }
  const { tokens } = flattenTokens(root)
  assert.deepEqual(colorModes(tokens, 'color.label').dark, [1, 1, 1, 1])
  assert.deepEqual(colorModes(tokens, 'color.label').light, [0, 0, 0, 1])

  root.color.label.$extensions = { [NS]: { modes: { dark: '{primitive.color.black}', hc: '#000' } } }
  const errors = errorsOf(root).join('\n')
  assert.match(errors, /modes に書けるのは dark だけ/)
})

test('a token that aliases a deprecated one is reported as deprecated, not as an error', () => {
  const root = minimalTokens()
  root.color.accent = { $value: '{color.tint}', $deprecated: 'color.tint を使う' }
  root.color.link = { $value: '{color.accent}' }
  const r = validateTokens(root, 'hig')
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.deprecated, ['"color.link" が、廃止されたトークン "color.accent" を使っています'])
})
