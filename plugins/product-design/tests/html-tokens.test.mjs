import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { NS, REQUIRED, cssVarName, generateCss } from '../scripts/check.mjs'
import { hex, minimalTokens } from './helpers.mjs'

const template = (base) => JSON.parse(readFileSync(new URL(`../templates/tokens/${base}.json`, import.meta.url), 'utf8'))

// :root の塊と、ダークの塊（prefers-color-scheme と data-theme）の中の宣言を読む。
const declarations = (css, selector) => {
  const start = css.indexOf(`${selector} {`)
  assert.ok(start >= 0, `${selector} の塊がありません`)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}

for (const base of ['hig', 'shadcn']) {
  test(`tokens.css from the ${base} template declares every required role`, () => {
    const css = generateCss(template(base))
    const light = declarations(css, ':root, [data-theme="light"]')
    for (const [group, names] of Object.entries(REQUIRED[base])) {
      for (const name of names) {
        const v = group === 'font' ? `--font-${name}` : cssVarName(`${group}.${name}`)
        assert.ok(light[v], `${v} がありません`)
      }
    }
  })
}

test('variable names follow the semantic role; non-colour groups keep the group name', () => {
  assert.equal(cssVarName('color.secondary-label'), '--secondary-label')
  assert.equal(cssVarName('space.2'), '--space-2')
  assert.equal(cssVarName('radius.md'), '--radius-md')
  assert.equal(cssVarName('shadow.sm'), '--shadow-sm')
  assert.equal(cssVarName('duration.fast'), '--duration-fast')
  assert.equal(cssVarName('easing.standard'), '--easing-standard')
  assert.equal(cssVarName('font.title-1'), '--font-title-1')
})

test('dark values come from modes.dark, in both the media query and data-theme="dark"', () => {
  const css = generateCss(template('hig'))
  assert.equal(declarations(css, ':root, [data-theme="light"]')['--tint'], '#0064d2')
  assert.equal(declarations(css, ':root:not([data-theme="light"])')['--tint'], '#409cff')
  assert.equal(declarations(css, '[data-theme="dark"]')['--tint'], '#409cff')
  assert.match(css, /@media \(prefers-color-scheme: dark\)/)
  // ダークで変わらない値（余白）は、ダークの塊に書かない
  assert.equal(declarations(css, '[data-theme="dark"]')['--space-2'], undefined)
})

test('colours with alpha are written as #rrggbbaa from their components', () => {
  const css = generateCss(template('hig'))
  // separator はライトで alpha 0.29（0.29 × 255 = 73.95 → 4a）
  assert.equal(declarations(css, ':root, [data-theme="light"]')['--separator'], '#3c3c434a')
})

test('the primitive tier is not written', () => {
  const css = generateCss(template('shadcn'))
  assert.doesNotMatch(css, /--primitive/)
})

test('typography becomes a font shorthand and a letter-spacing', () => {
  const css = generateCss(template('hig'))
  const light = declarations(css, ':root, [data-theme="light"]')
  assert.equal(light['--font-headline'], '600 17px/1.294 system-ui, -apple-system, sans-serif')
  assert.equal(light['--letter-spacing-headline'], '0px')
})

test('shadows, durations and easings become CSS values', () => {
  const css = generateCss(template('hig'))
  const light = declarations(css, ':root, [data-theme="light"]')
  assert.equal(light['--shadow-sm'], '0px 1px 2px 0px #0000000d')
  assert.match(light['--duration-fast'], /^\d+ms$/)
  assert.match(light['--easing-standard'], /^cubic-bezier\([\d., ]+\)$/)
})

test('font families with spaces are quoted', () => {
  const root = minimalTokens()
  root.font.body.$value.fontFamily = ['SF Pro Text', 'system-ui']
  const light = declarations(generateCss(root), ':root, [data-theme="light"]')
  assert.equal(light['--font-body'], '400 17px/1.3 "SF Pro Text", system-ui')
})

test('a colour aliasing another semantic colour follows its dark value', () => {
  const root = minimalTokens()
  root.color.label = { $value: hex('#000000'), $extensions: { [NS]: { modes: { dark: hex('#ffffff') } } } }
  root.color['secondary-label'] = { $value: '{color.label}' }
  const css = generateCss(root)
  assert.equal(declarations(css, '[data-theme="dark"]')['--secondary-label'], '#ffffff')
})

test('the same tokens give the same CSS, with a header that says not to edit it', () => {
  const a = generateCss(template('shadcn'))
  assert.equal(a, generateCss(template('shadcn')))
  assert.match(a.split('\n')[0], /手で直さない/)
})
