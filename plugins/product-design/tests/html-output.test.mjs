import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateCss, runCheck } from '../scripts/check.mjs'
import { tokens } from '../scripts/cli.mjs'
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

test('without an HTML output there is no tokens.css to check or write', () => {
  const files = validRepoFiles()
  files['design-system/design-system.json'] = config({ outputs: {} })
  const repo = tempRepo(files)
  assert.deepEqual(runCheck(repo).stale, [])
  assert.throws(() => tokens(repo), /outputs\.html/)
})
