import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { generateSwift, parseColor, swiftName, validateTokens } from '../scripts/check.mjs'

const starter = () => JSON.parse(readFileSync(new URL('../templates/tokens.json', import.meta.url), 'utf8'))

test('the starter tokens are valid', () => {
  assert.deepEqual(validateTokens(starter()), [])
})

test('names become Swift identifiers', () => {
  assert.equal(swiftName('text-primary'), 'textPrimary')
  assert.equal(swiftName('space-1'), 'space1')
  assert.equal(swiftName('radius-md'), 'radiusMd')
})

test('colors are read as rgba from #rgb, #rrggbb and #rrggbbaa', () => {
  assert.deepEqual(parseColor('#fff'), [1, 1, 1, 1])
  assert.deepEqual(parseColor('#000000'), [0, 0, 0, 1])
  assert.deepEqual(parseColor('#ff000080'), [1, 0, 0, 128 / 255])
  assert.equal(parseColor('red'), null)
  assert.equal(parseColor('#12345'), null)
})

test('a missing role, a duplicate name or a bad value is reported by token name', () => {
  const t = starter()
  t.color.tokens = t.color.tokens.filter((c) => c.name !== 'danger')
  t.color.tokens.push({ name: 'accent', value: '#000', usage: 'x' })
  t.color.tokens.push({ name: 'brand', value: { light: 'blue' }, usage: 'x' })
  t.spacing.tokens.push({ name: 'gap', value: '1rem', usage: 'x' })
  t.type.groups[0].styles.push({ name: 'huge', fontSize: '40px', lineHeight: '48px', fontWeight: 450, textStyle: 'giant' })
  const errors = validateTokens(t).join('\n')
  assert.match(errors, /danger/)
  assert.match(errors, /accent.*重複/)
  assert.match(errors, /brand.*色/)
  assert.match(errors, /gap.*px/)
  assert.match(errors, /huge.*fontWeight/)
  assert.match(errors, /huge.*textStyle/)
})

test('names must be lower kebab-case so they map to Swift', () => {
  const t = starter()
  t.radius.tokens.push({ name: 'Radius XL', value: '20px', usage: 'x' })
  assert.match(validateTokens(t).join('\n'), /Radius XL/)
})

test('the light theme is required and a missing dark value falls back to light', () => {
  const t = starter()
  t.color.tokens.push({ name: 'brand', value: '#336699', usage: 'ブランドの色' })
  assert.deepEqual(validateTokens(t), [])
  const swift = generateSwift(t)
  assert.match(swift, /static let brand = dynamic\(light: \(0\.2, 0\.4, 0\.6, 1\), dark: \(0\.2, 0\.4, 0\.6, 1\)\)/)
  t.color.themes = [{ id: 'dark', name: 'Dark' }]
  assert.match(validateTokens(t).join('\n'), /light/)
})

test('the generated Swift has every family under DS, with usage as doc comments', () => {
  const swift = generateSwift(starter())
  assert.match(swift, /^\/\/ tokens\.json から生成/)
  assert.match(swift, /enum DS \{/)
  assert.match(swift, /enum Color \{/)
  assert.match(swift, /\/\/\/ 本文と見出しの文字\n\s+static let textPrimary = dynamic\(light: \(0, 0, 0, 1\), dark: \(1, 1, 1, 1\)\)/)
  assert.match(swift, /static var body: SwiftUI\.Font \{ scaled\(17, \.regular, \.body\) \}/)
  assert.match(swift, /static var title: SwiftUI\.Font \{ scaled\(28, \.bold, \.title1\) \}/)
  assert.match(swift, /static let space4: CGFloat = 16/)
  assert.match(swift, /static let radiusMd: CGFloat = 10/)
})

test('every family also lists its tokens, so the catalog follows tokens.json', () => {
  const swift = generateSwift(starter())
  assert.match(swift, /static let all: \[\(name: String, color: SwiftUI\.Color, usage: String\)\] = \[\n\s+\("background", background, "画面の背景"\),/)
  assert.match(swift, /static var all: \[\(name: String, font: SwiftUI\.Font, usage: String\)\] \{\n\s+\[\n\s+\("title", title, "画面の見出し"\),/)
  assert.match(swift, /\("space-4", space4, "画面の左右、カードの内側"\),/)
  assert.match(swift, /\("radius-lg", radiusLg, "カード、バナー"\),/)
})

test('usage text is escaped as a Swift string', () => {
  const t = starter()
  t.radius.tokens[0].usage = 'a "quoted" \\ b'
  assert.match(generateSwift(t), /\("radius-sm", radiusSm, "a \\"quoted\\" \\\\ b"\)/)
})

test('a custom font family is used by name and still scales', () => {
  const t = starter()
  t.type.families.serif = '"Hiragino Mincho ProN", serif'
  t.type.groups.push({ name: 'Display', family: 'serif', styles: [{ name: 'display', fontSize: '34px', lineHeight: '41px', fontWeight: 400, textStyle: 'largeTitle' }] })
  assert.match(generateSwift(t), /static var display: SwiftUI\.Font \{ \.custom\("Hiragino Mincho ProN", size: 34, relativeTo: \.largeTitle\) \}/)
})

test('the same tokens always give the same Swift', () => {
  assert.equal(generateSwift(starter()), generateSwift(starter()))
})
