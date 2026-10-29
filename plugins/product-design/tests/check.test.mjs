import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCheck } from '../scripts/check.mjs'
import { config, tempRepo, validRepoFiles } from './helpers.mjs'

const CHECK = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url))

// アプリに写したときと同じく、design-system/check.mjs から動かす。
function run(files, ...args) {
  const repo = tempRepo(files)
  copyFileSync(CHECK, join(repo, 'design-system', 'check.mjs'))
  const r = spawnSync(process.execPath, [join(repo, 'design-system', 'check.mjs'), ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const broken = () => {
  const files = validRepoFiles()
  files['design-system/principles.md'] = '### D1 a\n'
  return files
}

test('a valid repository passes, also with --strict, and --json has the documented fields', () => {
  assert.equal(run(validRepoFiles()).code, 0)
  const r = run(validRepoFiles(), '--strict', '--json')
  assert.equal(r.code, 0)
  assert.deepEqual(Object.keys(JSON.parse(r.out)), ['ok', 'violations', 'ds_errors', 'warnings', 'stale', 'deprecated', 'candidates', 'allowed', 'files'])
})

test('a problem inside the design system only fails with --strict', () => {
  const plain = run(broken(), '--json')
  assert.equal(plain.code, 0)
  assert.equal(JSON.parse(plain.out).ok, true)
  assert.match(JSON.parse(plain.out).ds_errors.join('\n'), /trace-none/)
  const strict = run(broken(), '--strict')
  assert.equal(strict.code, 1)
  assert.match(strict.out, /デザインシステムの中の不備/)
})

test('warnings and open candidates do not fail, even with --strict', () => {
  const files = validRepoFiles()
  files['docs/product/principles.md'] += '### P2 使われない\n'
  files['docs/design-candidates/chip.md'] = '---\nstatus: open\nscreens: [ListView]\n---\n'
  const r = run(files, '--strict', '--json')
  assert.equal(r.code, 0)
  const out = JSON.parse(r.out)
  assert.match(out.warnings.join('\n'), /trace-orphan: P2/)
  assert.deepEqual(out.candidates, [{ file: 'docs/design-candidates/chip.md', screens: ['ListView'] }])
})

test('the check cannot run without a v2 config or readable tokens (exit code 2)', () => {
  const noConfig = validRepoFiles()
  delete noConfig['design-system/design-system.json']
  noConfig['design-system/README.md'] = '# x\n'
  assert.equal(run(noConfig).code, 2)

  const v1 = validRepoFiles()
  v1['design-system/design-system.json'] = { ...config(), version: 1 }
  const r = run(v1)
  assert.equal(r.code, 2)
  assert.match(r.err, /version が 2 ではありません/)

  const badTokens = validRepoFiles()
  badTokens['design-system/tokens.json'] = '{ not json'
  assert.equal(run(badTokens).code, 2)
})

test('a bad stage name or state is an error inside the design system', () => {
  const files = validRepoFiles()
  files['design-system/design-system.json'] = config({ stages: { product: 'done', html: 'approved' } })
  const r = runCheck(tempRepo(files))
  assert.equal(r.ds_errors.filter((e) => e.includes('stages.')).length, 2)
})
