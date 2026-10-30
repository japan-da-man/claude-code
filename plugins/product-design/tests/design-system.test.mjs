// Claude の Design System（Artifact の型）が読むトークンの形への変換。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { NS, REQUIRED } from '../scripts/check.mjs'
import { toDesignSystemTokens } from '../scripts/cli.mjs'
import { hex, minimalTokens } from './helpers.mjs'

const template = (base) => JSON.parse(readFileSync(new URL(`../templates/tokens/${base}.json`, import.meta.url), 'utf8'))
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/

const keysDeep = (v) => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysDeep(x)]) : [])

for (const base of ['hig', 'shadcn']) {
  test(`${base}: every family is a list the page can read, with unique names`, () => {
    const ds = toDesignSystemTokens(template(base), { title: 'App', base })
    assert.equal(ds.name, 'App')
    assert.deepEqual(ds.color.themes.map((t) => t.id), ['light', 'dark'])
    assert.deepEqual(ds.color.tokens.map((t) => t.name).sort(), [...REQUIRED[base].color].sort())
    for (const t of ds.color.tokens) {
      assert.match(t.value.light, HEX, t.name)
      assert.match(t.value.dark, HEX, t.name)
      assert.ok(t.usage, `${t.name} の usage`)
    }
    const names = Object.entries(ds).filter(([k, v]) => k !== 'type' && Array.isArray(v?.tokens)).flatMap(([, v]) => v.tokens.map((t) => t.name))
    for (const n of names) assert.match(n, NAME)
    assert.equal(new Set(names).size, names.length)
    assert.equal(keysDeep(ds).some((k) => k.startsWith('$')), false)
  })

  test(`${base}: type, spacing, radius, shadow and motion keep their values`, () => {
    const ds = toDesignSystemTokens(template(base), { title: 'App', base })
    assert.deepEqual(ds.type.families, { system: 'system-ui, -apple-system, sans-serif' })
    const styles = ds.type.groups.flatMap((g) => g.styles)
    assert.deepEqual(styles.map((s) => s.name), REQUIRED[base].font)
    assert.deepEqual(styles.find((s) => s.name === 'headline'), { name: 'headline', fontSize: '17px', lineHeight: 1.294, fontWeight: 600, letterSpacing: '0px', usage: '行の見出し、ボタンの文字' })
    assert.deepEqual(ds.spacing.tokens.map((t) => [t.name, t.value]).slice(0, 2), [['space-1', '4px'], ['space-2', '8px']])
    assert.deepEqual(ds.radius.tokens.map((t) => t.name), ['radius-sm', 'radius-md', 'radius-lg'])
    assert.equal(ds.shadow.tokens[0].value, '0px 1px 2px 0px #0000000d')
    assert.match(ds.duration.tokens[0].value, /^\d+ms$/)
    assert.match(ds.easing.tokens[0].value, /^cubic-bezier\(/)
  })
}

test('the HIG tint keeps its light and dark values, and alpha becomes #rrggbbaa', () => {
  const ds = toDesignSystemTokens(template('hig'), { title: 'App', base: 'hig' })
  assert.deepEqual(ds.color.tokens.find((t) => t.name === 'tint').value, { light: '#0064d2', dark: '#409cff' })
  assert.equal(ds.color.tokens.find((t) => t.name === 'separator').value.light, '#3c3c434a')
})

test('a deprecated token says so in its usage, and the source is recorded in meta', () => {
  const root = minimalTokens()
  root.color.fill.$deprecated = 'secondary-fill を使う'
  root.color.fill.$description = '塗り'
  const ds = toDesignSystemTokens(root, { title: 'App', base: 'hig', ds_version: '1.2.0' })
  assert.equal(ds.color.tokens.find((t) => t.name === 'fill').usage, '（廃止: secondary-fill を使う）塗り')
  assert.deepEqual(ds.meta, { source: 'product-design', base: 'hig', ds_version: '1.2.0', tokens: 'design-system/tokens.json' })
})

test('a role added in its own group becomes its own family, and a shadow with a dark mode has both values', () => {
  const root = minimalTokens()
  root.opacity = { $type: 'number', $extensions: { [NS]: { from: ['D1'] } }, disabled: { $value: 0.4, $description: '押せない部品' } }
  root.shadow.md.$extensions = { [NS]: { modes: { dark: { color: hex('#ffffff', 0.1), offsetX: { value: 0, unit: 'px' }, offsetY: { value: 1, unit: 'px' }, blur: { value: 2, unit: 'px' }, spread: { value: 0, unit: 'px' } } } } }
  const ds = toDesignSystemTokens(root, { title: 'App', base: 'hig' })
  assert.deepEqual(ds.opacity.tokens, [{ name: 'opacity-disabled', value: '0.4', usage: '押せない部品' }])
  assert.deepEqual(ds.shadow.tokens.find((t) => t.name === 'shadow-md').value, { light: '0px 1px 2px 0px #0000001a', dark: '0px 1px 2px 0px #ffffff1a' })
})

test('a font family named like a text style gets its own name, so .body keeps working', () => {
  const root = minimalTokens()
  root.primitive['font-family'] = { $type: 'fontFamily', body: { $value: ['system-ui'] } }
  for (const k of Object.keys(root.font).filter((k) => !k.startsWith('$'))) root.font[k].$value.fontFamily = '{primitive.font-family.body}'
  const ds = toDesignSystemTokens(root, { title: 'App', base: 'hig' })
  assert.deepEqual(Object.keys(ds.type.families), ['body-family'])
  assert.equal(ds.type.groups[0].family, 'body-family')
})
