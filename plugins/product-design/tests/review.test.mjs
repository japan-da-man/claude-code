// レビューで見つかった穴を、本当に失敗しうる入力で確かめる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NS, checkContrast, checkTrace, collectTrace, colorModes, flattenTokens, parseFrontMatter, readPrinciples, readSections, traceFrom, validateTokens } from '../scripts/check.mjs'
import { install, status, stage, trace } from '../scripts/cli.mjs'
import { config, hex, minimalTokens, tempRepo, validRepoFiles } from './helpers.mjs'

const CHECK = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url))
const CLI = fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url))
const errorsOf = (root) => validateTokens(root, 'hig').errors.join('\n')
const pairs = (root, list) => {
  root.$extensions = { [NS]: { contrast: list } }
  return checkContrast(root, flattenTokens(root).tokens)
}

test('a cycle that comes back through a composite value is reported, not a crash', () => {
  const self = minimalTokens()
  self.shadow.sm.$value.color = '{shadow.sm}'
  assert.match(errorsOf(self), /"shadow\.sm": 別名が循環しています/)
  const mutual = minimalTokens()
  mutual.shadow.sm = { $value: '{shadow.md}' }
  mutual.shadow.md.$value = { ...mutual.shadow.md.$value, color: '{shadow.sm}' }
  assert.match(errorsOf(mutual), /循環/)
})

test('$deprecated: false is not deprecated', () => {
  const root = minimalTokens()
  root.color.accent = { $value: '{color.tint}', $deprecated: false }
  root.color.link = { $value: '{color.accent}' }
  assert.deepEqual(validateTokens(root, 'hig').deprecated, [])
  const files = validRepoFiles()
  files['design-system/tokens.json'] = minimalTokens()
  files['design-system/tokens.json'].color.extra = { $value: hex('#000000'), $deprecated: false, $extensions: { [NS]: { from: [] } } }
  const r = checkTrace(collectTrace(tempRepo(files), config(), flattenTokens(files['design-system/tokens.json']).tokens))
  assert.match(r.errors.join('\n'), /trace-none: .*color\.extra/)
})

test('a deprecated token reached through modes.dark is reported', () => {
  const root = minimalTokens()
  root.primitive.color = { $type: 'color', old: { $value: hex('#ffffff'), $deprecated: 'white を使う' } }
  root.color.label.$extensions = { [NS]: { modes: { dark: '{primitive.color.old}' } } }
  assert.match(validateTokens(root, 'hig').deprecated.join('\n'), /"color\.label" が、廃止されたトークン "primitive\.color\.old"/)
})

test('a deprecated semantic token without a basis is not trace-none', () => {
  const files = validRepoFiles()
  const tokens = minimalTokens()
  tokens.color.accent = { $value: '{color.tint}', $deprecated: 'tint を使う', $extensions: { [NS]: { from: [] } } }
  files['design-system/tokens.json'] = tokens
  const r = checkTrace(collectTrace(tempRepo(files), config(), flattenTokens(tokens).tokens))
  assert.doesNotMatch(r.errors.join('\n'), /color\.accent/)
})

test('an alias without its own modes.dark takes the dark value of the token it points to', () => {
  const root = minimalTokens()
  root.color['system-background'] = { $value: hex('#ffffff'), $extensions: { [NS]: { modes: { dark: hex('#000000') } } } }
  root.color.label = { $value: hex('#000000'), $extensions: { [NS]: { modes: { dark: hex('#ffffff') } } } }
  root.color.card = { $value: '{color.system-background}' }
  assert.deepEqual(colorModes(flattenTokens(root).tokens, 'color.card').dark, [0, 0, 0, 1])
  assert.deepEqual(pairs(root, [{ fg: 'label', bg: 'card' }]).errors, [])
})

test('a translucent foreground is laid over the background before measuring', () => {
  const root = minimalTokens()
  // 黒の 30% は白の上でほぼ灰色（約 2.4:1）。合成しなければ 21:1 と誤る。
  root.color['tertiary-label'] = { $value: hex('#000000', 0.3) }
  assert.match(pairs(root, [{ fg: 'tertiary-label', bg: 'system-background' }]).errors.join('\n'), /2\.\d+:1 で、4\.5:1 に届きません/)
})

test('over is used for the colour under a translucent background, and must itself be opaque', () => {
  const root = minimalTokens()
  // 黒 50% の背景は、白に重ねると灰色（黒い文字で約 5.3:1）、黒に重ねると黒（黒い文字で 1:1）。over で結果が変わる組にする。
  // 色を不透明にするだけ（合成しない）だと黒になり、白に重ねた組まで落ちる。
  root.color.fill = { $value: hex('#000000', 0.5) }
  root.color.label = { $value: hex('#000000') }
  root.color['secondary-label'] = { $value: hex('#000000') }
  assert.equal(pairs(root, [{ fg: 'label', bg: 'fill', over: 'system-background' }]).errors.length, 0)
  assert.equal(pairs(root, [{ fg: 'label', bg: 'fill', over: 'secondary-label' }]).errors.length, 2)
  root.color['secondary-fill'] = { $value: hex('#ffffff', 0.5) }
  assert.match(pairs(root, [{ fg: 'label', bg: 'fill', over: 'secondary-fill' }]).errors[0], /over の secondary-fill も半透明/)
})

test('modes.dark values are checked for shape and for their target', () => {
  const missing = minimalTokens()
  missing.color.label.$extensions = { [NS]: { modes: { dark: '{color.nothing}' } } }
  assert.match(errorsOf(missing), /modes\.dark: 参照先 \{color\.nothing\} がありません/)
  const shape = minimalTokens()
  shape.color.label.$extensions = { [NS]: { modes: { dark: '#ffffff' } } }
  assert.match(errorsOf(shape), /"color\.label" の modes\.dark: color は/)
})

test('typography needs a letterSpacing, unknown $type values and empty shadows are errors', () => {
  const root = minimalTokens()
  delete root.font.body.$value.letterSpacing
  root.font.headline.$value.letterSpacing = 'wide'
  root.radius.$type = 'dimesion'
  root.shadow.sm.$value = []
  root.border = { $type: 'border', thin: { $value: { any: 'shape' } } }
  const errors = errorsOf(root)
  assert.match(errors, /"font\.body": typography に letterSpacing がありません/)
  assert.match(errors, /"font\.headline": typography の letterSpacing は/)
  assert.match(errors, /"radius\.sm" の \$type "dimesion" は DTCG の型ではありません/)
  assert.match(errors, /"shadow\.sm": shadow の配列が空です/)
  assert.doesNotMatch(errors, /"border\.thin"/)
})

test('front matter keeps quoted commas, brackets and hashes, and reports what it cannot read', () => {
  const { data, problems } = parseFrontMatter('﻿---\nname: "a # b"\nscreens: ["一覧, 詳細", 設定]\noutputs: { html: "a}b", swiftui: X }\nnote: don\'t # コメント\nnested:\n  swiftui: X\n---\n')
  assert.equal(data.name, 'a # b')
  assert.deepEqual(data.screens, ['一覧, 詳細', '設定'])
  assert.deepEqual(data.outputs, { html: 'a}b', swiftui: 'X' })
  assert.equal(data.note, "don't")
  assert.equal(problems.length, 1)
  assert.match(problems[0], /swiftui: X/)
})

test('headings inside code blocks are not principles or sections', () => {
  const doc = '### D1 本物\n根拠: P1\n\n```markdown\n### D2 例\n## 例の節\n```\n## 本物の節\n根拠: D1\n'
  assert.deepEqual([...readPrinciples(doc, 'D').ids.keys()], ['D1'])
  assert.deepEqual(readSections(doc).map((s) => s.title), ['本物の節'])
})

test('a from that is not a list is an error, not a silent missing basis', () => {
  const files = validRepoFiles()
  files['design-system/components/button.md'] = '---\nname: button\nstatus: stable\nfrom: D1\n---\n'
  const tokens = minimalTokens()
  tokens.radius.$extensions = { [NS]: { from: 'D1' } }
  files['design-system/tokens.json'] = tokens
  const t = collectTrace(tempRepo(files), config(), flattenTokens(tokens).tokens)
  assert.match(checkTrace(t).errors.join('\n'), /button\.md: from は \[D1, D2\] の形/)
  assert.match(flattenTokens(tokens).errors.join('\n'), /"radius" の from は配列にしてください/)
})

test('trace reaches tokens that use a primitive inside a composite value', () => {
  const repo = tempRepo({ 'a.txt': '' })
  install(repo, { base: 'hig' })
  const r = trace(repo, 'primitive.font-family.system')
  assert.equal(r.affected.filter((a) => a.where.includes(' font.')).length, 11)
  // HTML の出力があるので、文字のトークンを使う部品まで届く
  assert.equal(r.note, undefined)
  assert.ok(r.affected.some((a) => a.outputs?.html === 'button'))
  const t = collectTrace(repo, { ...config(), product_principles: 'docs/product/principles.md' }, flattenTokens(JSON.parse(spawnSync('cat', [join(repo, 'design-system/tokens.json')], { encoding: 'utf8' }).stdout)).tokens)
  const fromP = traceFrom(t, 'P3')
  const d1 = fromP.find((a) => a.where.includes('principles.md') && a.where.endsWith(' D1'))
  assert.equal(d1.depth, 1)
})

test('install does not bring back a template that was deleted, but --add places it', () => {
  const repo = tempRepo({ 'a.txt': '' })
  install(repo, { base: 'hig' })
  rmSync(join(repo, 'design-system/components/toast.md'))
  const again = install(repo, { base: 'shadcn' })
  assert.deepEqual(again.copied, [])
  assert.deepEqual(again.available, ['design-system/components/toast.md'])
  assert.match(again.note, /base は hig のまま/)
  assert.equal(existsSync(join(repo, 'design-system/components/toast.md')), false)
  assert.deepEqual(install(repo, { add: ['design-system/components/toast.md'] }).copied, ['design-system/components/toast.md'])
  assert.throws(() => install(repo, { add: ['design-system/components/nothing.md'] }), /ひな形のない道のり/)
})

test('the command lines fail cleanly on a missing argument', () => {
  const repo = tempRepo(validRepoFiles())
  copyFileSync(CHECK, join(repo, 'design-system', 'check.mjs'))
  const noValue = spawnSync(process.execPath, [join(repo, 'design-system', 'check.mjs'), '--json', '--repo'], { encoding: 'utf8' })
  assert.equal(noValue.status, 2)
  assert.equal(JSON.parse(noValue.stdout).ok, false)
  const noRepo = spawnSync(process.execPath, [CLI, 'install', '--base', 'hig'], { encoding: 'utf8', cwd: repo })
  assert.equal(noRepo.status, 1)
  assert.equal(existsSync(join(repo, '--base')), false)
})

test('the CLI runs through a symlink', () => {
  const dir = tempRepo({ 'a.txt': '' })
  const link = join(dir, 'plugin')
  symlinkSync(dirname(dirname(CLI)), link)
  const target = tempRepo({ 'a.txt': '' })
  const r = spawnSync(process.execPath, [join(link, 'scripts', 'cli.mjs'), 'install', target, '--base', 'hig'], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).config, 'created')
})
