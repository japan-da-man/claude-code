import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateCss, runCheck } from '../scripts/check.mjs'
import { install, tokens } from '../scripts/cli.mjs'
import { config, hex, tempRepo, validRepoFiles } from './helpers.mjs'

const CSS = 'design-system/html/tokens.css'

test('cli tokens writes tokens.css into the HTML output, and then nothing is stale', () => {
  const repo = tempRepo(validRepoFiles())
  assert.match(runCheck(repo).stale.join('\n'), /tokens\.css がありません/)
  const r = tokens(repo)
  assert.deepEqual(r, { written: [CSS], errors: [] })
  const root = JSON.parse(readFileSync(join(repo, 'design-system/tokens.json'), 'utf8'))
  assert.equal(readFileSync(join(repo, CSS), 'utf8'), generateCss(root))
  assert.deepEqual(runCheck(repo).stale, [])
})

test('a changed tokens.json makes tokens.css stale', () => {
  const repo = tempRepo(validRepoFiles())
  tokens(repo)
  const file = join(repo, 'design-system/tokens.json')
  const root = JSON.parse(readFileSync(file, 'utf8'))
  root.color.label.$value = hex('#111111')
  writeFileSync(file, JSON.stringify(root))
  assert.match(runCheck(repo).stale.join('\n'), /tokens\.css が tokens\.json と合っていません/)
})

test('cli tokens writes nothing while tokens.json has errors', () => {
  const files = validRepoFiles()
  delete files['design-system/tokens.json'].color.label
  const repo = tempRepo(files)
  const r = tokens(repo)
  assert.deepEqual(r.written, [])
  assert.match(r.errors.join('\n'), /color\.label/)
})

test('a new install places the HTML output and writes its tokens.css, leaving nothing stale', () => {
  const repo = tempRepo({ 'README.md': '# app\n' })
  const r = install(repo, { base: 'shadcn' })
  assert.deepEqual(r.tokens, { written: [CSS], errors: [] })
  for (const f of ['tokens.css', 'base.css', 'theme.js', 'index.html']) assert.ok(existsSync(join(repo, 'design-system/html', f)), f)
  assert.match(readFileSync(join(repo, 'design-system/html/base.css'), 'utf8'), /shadcn\/ui/)
  assert.equal(existsSync(join(repo, 'design-system/html/base.shadcn.css')), false)
  assert.deepEqual(JSON.parse(readFileSync(join(repo, 'design-system/design-system.json'), 'utf8')).outputs, { html: { code: 'design-system/html' } })
  assert.deepEqual(runCheck(repo).stale, [])
})

test('install adds the HTML output to a config from stage 1, and later keeps deleted HTML files out', () => {
  const repo = tempRepo({ 'README.md': '# app\n' })
  install(repo, { base: 'hig' })
  const file = join(repo, 'design-system/design-system.json')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), outputs: {} }))
  rmSync(join(repo, 'design-system/html'), { recursive: true })

  const r = install(repo)
  assert.equal(r.html_added, true)
  assert.ok(r.copied.includes('design-system/html/index.html'))
  assert.ok(existsSync(join(repo, CSS)))
  assert.deepEqual(r.available, [])

  rmSync(join(repo, 'design-system/html/index.html'))
  const again = install(repo)
  assert.equal(again.html_added, undefined)
  assert.deepEqual(again.available, ['design-system/html/index.html'])
})

test('without an HTML output there is no tokens.css to check or write', () => {
  const files = validRepoFiles()
  files['design-system/design-system.json'] = config({ outputs: {} })
  const repo = tempRepo(files)
  assert.deepEqual(runCheck(repo).stale, [])
  assert.throws(() => tokens(repo), /outputs\.html/)
})

test('a tokens.json that is not JSON makes tokens and install report it instead of throwing', () => {
  const repo = tempRepo({ 'README.md': '# app\n' })
  install(repo, { base: 'hig' })
  writeFileSync(join(repo, 'design-system/tokens.json'), '{ broken')
  assert.deepEqual(tokens(repo).written, [])
  assert.match(tokens(repo).errors[0], /tokens\.json が読めません/)
  assert.match(install(repo).tokens.errors[0], /tokens\.json が読めません/)
})
