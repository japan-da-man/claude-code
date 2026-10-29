import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NS, checkContrast, composite, contrastRatio, flattenTokens } from '../scripts/check.mjs'
import { hex, minimalTokens } from './helpers.mjs'

const c = (h) => [...hex(h).components, 1]
const ratio = (a, b) => Number(contrastRatio(c(a), c(b)).toFixed(2))

test('ratios match the WCAG formula', () => {
  assert.equal(ratio('#000000', '#ffffff'), 21)
  assert.equal(ratio('#0064d2', '#ffffff'), 5.59)
  assert.equal(ratio('#ffffff', '#007aff'), 4.02)
  assert.equal(ratio('#737373', '#f5f5f5'), 4.35)
})

test('a translucent colour is laid over its backdrop first', () => {
  const secondaryLabel = composite([60 / 255, 60 / 255, 67 / 255, 0.6], [1, 1, 1, 1])
  assert.equal(Number(contrastRatio(secondaryLabel, [1, 1, 1, 1]).toFixed(2)), 3.44)
})

function withPairs(pairs, edit = () => {}) {
  const root = minimalTokens()
  edit(root)
  root.$extensions = { [NS]: { contrast: pairs } }
  return checkContrast(root, flattenTokens(root).tokens)
}

test('text pairs below 4.5:1 fail in either mode, large text needs 3:1, UI pairs only warn', () => {
  const grey = (root) => {
    root.color['secondary-label'] = { $value: hex('#8a8a8e'), $extensions: { [NS]: { modes: { dark: hex('#ffffff') } } } }
  }
  const text = withPairs([{ fg: 'secondary-label', bg: 'system-background' }], grey)
  assert.equal(text.errors.length, 2)
  // 比は切り捨てて見せる（3.4399… → 3.43）
  assert.match(text.errors[0], /（light）が 3\.43:1 で、4\.5:1 に届きません/)
  assert.match(text.errors[1], /（dark）が 1\.00:1/)

  assert.equal(withPairs([{ fg: 'secondary-label', bg: 'system-background', kind: 'large-text' }], (r) => (r.color['secondary-label'] = { $value: hex('#8a8a8e') })).errors.length, 0)

  const ui = withPairs([{ fg: 'secondary-label', bg: 'system-background', kind: 'ui' }], (r) => (r.color['secondary-label'] = { $value: hex('#dddddd') }))
  assert.equal(ui.errors.length, 0)
  assert.equal(ui.warnings.length, 2)
})

test('a role pinned to a system colour may stay in a pair that passes, and a failing one says how to fix it', () => {
  const passing = withPairs([{ fg: 'label', bg: 'system-background' }], (r) => (r.color.label.$extensions = { [NS]: { swiftui: { system: 'label' } } }))
  assert.deepEqual(passing.errors, [])

  const failing = withPairs([{ fg: 'secondary-label', bg: 'system-background' }], (r) => {
    r.color['secondary-label'] = { $value: hex('#8a8a8e'), $extensions: { [NS]: { swiftui: { system: 'secondaryLabel' } } } }
  })
  assert.match(failing.errors[0], /swiftui\.system を外して独自の値にする/)
})

test('a translucent background needs over, and unknown roles or kinds are errors', () => {
  const glass = (r) => (r.color.fill = { $value: hex('#787880', 0.2) })
  assert.match(withPairs([{ fg: 'label', bg: 'fill' }], glass).errors[0], /over に書いてください/)
  assert.deepEqual(withPairs([{ fg: 'label', bg: 'fill', over: 'system-background' }], glass).errors, [])
  assert.match(withPairs([{ fg: 'label', bg: 'nothing' }]).errors[0], /色の役割が見つからない/)
  assert.match(withPairs([{ fg: 'label', bg: 'system-background', kind: 'huge' }]).errors[0], /kind は text・large-text・ui/)
})
