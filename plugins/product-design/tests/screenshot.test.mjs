import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findChrome, install, screenshot } from '../scripts/cli.mjs'
import { tempRepo } from './helpers.mjs'

// 呼ばれた引数を書き残し、--screenshot= の先に PNG の代わりのファイルを書く、Chrome の代わり。
function fakeChrome(dir) {
  const file = join(dir, 'fake-chrome.mjs')
  writeFileSync(
    file,
    `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(join(dir, 'calls.jsonl'))}, JSON.stringify(args) + '\\n')
writeFileSync(args.find((a) => a.startsWith('--screenshot=')).slice(13), 'png')
`,
  )
  chmodSync(file, 0o755)
  return file
}

const addButton = (repo) => {
  mkdirSync(join(repo, 'design-system/html/components'), { recursive: true })
  writeFileSync(join(repo, 'design-system/html/components/button.html'), '<main class="ds-page" data-group="操作" data-height="300"></main>')
}

const calls = (dir) => readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

test('screenshot shoots each page in light and dark into screenshots/html', () => {
  const repo = tempRepo({ 'README.md': '# app\n' })
  install(repo, { base: 'hig' })
  const chrome = fakeChrome(repo)
  const r = screenshot(repo, { chrome, pages: ['index'] })
  assert.deepEqual(r.shots.map((s) => s.path), ['design-system/screenshots/html/index-light.png', 'design-system/screenshots/html/index-dark.png'])
  for (const s of r.shots) assert.ok(existsSync(join(repo, s.path)), s.path)
  const [light, dark] = calls(repo)
  assert.ok(light.includes('--headless=new'))
  assert.ok(light.some((a) => a.startsWith('--user-data-dir=')))
  assert.match(light.at(-1), /^file:\/\/.*\/design-system\/html\/index\.html\?theme=light$/)
  assert.match(dark.at(-1), /\?theme=dark$/)
})

test('a component page is named by its stem and sized from its data-height', () => {
  const repo = tempRepo({ 'README.md': '# app\n' })
  install(repo, { base: 'hig' })
  addButton(repo)
  const chrome = fakeChrome(repo)
  const r = screenshot(repo, { chrome, pages: ['button'] })
  assert.equal(r.shots[0].path, 'design-system/screenshots/html/button-light.png')
  assert.ok(calls(repo)[0].includes('--window-size=560,460'))
})

test('every page is shot when none are named, and an unknown page is an error', () => {
  const repo = tempRepo({ 'README.md': '# app\n' })
  install(repo, { base: 'hig' })
  addButton(repo)
  const r = screenshot(repo, { chrome: fakeChrome(repo) })
  const pages = [...new Set(r.shots.map((s) => s.page))]
  assert.equal(pages[0], 'index')
  assert.ok(pages.includes('button'))
  assert.equal(r.shots.length, pages.length * 2)
  assert.throws(() => screenshot(repo, { chrome: fakeChrome(repo), pages: ['nothing'] }), /nothing/)
})

test('without Chrome nothing is shot and the reason is given', () => {
  const repo = tempRepo({ 'README.md': '# app\n' })
  install(repo, { base: 'hig' })
  const r = screenshot(repo, { chrome: null })
  assert.equal(r.skipped, true)
  assert.match(r.reason, /Chrome/)
  assert.deepEqual(r.shots, [])
})

test('findChrome prefers $CHROME and ignores a path that does not exist', () => {
  const dir = tempRepo({ 'a.txt': '' })
  const chrome = fakeChrome(dir)
  assert.equal(findChrome({ CHROME: chrome, PATH: '' }), chrome)
  assert.notEqual(findChrome({ CHROME: join(dir, 'nothing'), PATH: '' }), join(dir, 'nothing'))
})

// 失敗する Chrome の代わり（終了コード 1 か、何も書かずに 0 で終わる）。
function brokenChrome(dir, code) {
  const file = join(dir, `broken-chrome-${code}.mjs`)
  writeFileSync(file, `#!${process.execPath}\nprocess.exit(${code})\n`)
  chmodSync(file, 0o755)
  return file
}

test('a Chrome that fails or writes nothing is an error, even with an old picture left over', () => {
  const repo = tempRepo({ 'README.md': '# app\n' })
  install(repo, { base: 'hig' })
  screenshot(repo, { chrome: fakeChrome(repo), pages: ['index'] })
  assert.throws(() => screenshot(repo, { chrome: brokenChrome(repo, 1), pages: ['index'] }), /撮れませんでした/)
  assert.throws(() => screenshot(repo, { chrome: brokenChrome(repo, 0), pages: ['index'] }), /撮れませんでした/)
})
