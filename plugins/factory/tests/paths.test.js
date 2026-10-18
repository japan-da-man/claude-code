import { test } from 'node:test'
import assert from 'node:assert/strict'
import { featureId, featureDir, projectHome, projectSlug } from '../line/paths.js'

test('project slug is readable and unique per absolute path', () => {
  const a = projectSlug('/Users/me/Projects/memo-app')
  const b = projectSlug('/Users/me/Work/memo-app')
  assert.match(a, /^memo-app-[0-9a-f]{8}$/)
  assert.notEqual(a, b)
  assert.equal(a, projectSlug('/Users/me/Projects/memo-app/'))
})

test('project home and feature dir live under the factory home', () => {
  const home = projectHome('/Users/me/Projects/memo-app', '/tmp/fh')
  assert.ok(home.startsWith('/tmp/fh/memo-app-'))
  assert.equal(featureDir(home, '20261018-share-memo'), `${home}/20261018-share-memo`)
})

test('feature id is date plus kebab-case name', () => {
  assert.equal(featureId('Share Memo!', new Date(2026, 9, 18)), '20261018-share-memo')
  assert.equal(featureId('  dark   mode ', new Date(2026, 0, 2)), '20260102-dark-mode')
  assert.throws(() => featureId('共有', new Date(2026, 9, 18)), /英語/)
})

test('feature dir rejects ids that would escape the project home', () => {
  assert.throws(() => featureDir('/tmp/fh/p', '../x'), /id/)
})
