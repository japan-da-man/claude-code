import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { install, status, templatePath, VENDORED } from '../scripts/cli.mjs'
import { parseMarkdown, parseYamlSubset, runCheck } from '../scripts/check.mjs'
import { makeRepo, writeFiles } from './helpers.mjs'

const CLI = fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url))
const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url))

test('install: check.mjs を写し、設定とひな形を置く。2 回目は何も上書きしない', () => {
  const repo = makeRepo({ 'actors.yaml': 'actors: []\n' })
  const first = install(repo)
  assert.ok(first.copied.includes(VENDORED))
  assert.ok(first.copied.includes('feature-docs/config.json'))
  assert.ok(first.copied.includes('docs/product/overview.md'))
  assert.ok(first.copied.includes('feature-docs/README.md'))
  assert.ok(first.skipped.includes('actors.yaml'))
  assert.ok(first.created_dirs.includes('features'))
  assert.equal(existsSync(join(repo, '.github/workflows/feature-docs.yml')), false)
  assert.equal(runCheck(repo).ok, true)

  const second = install(repo, { ci: true, prTemplate: true })
  assert.deepEqual(second.updated, [])
  assert.ok(!second.copied.includes(VENDORED))
  assert.deepEqual(second.copied, ['.github/workflows/feature-docs.yml', '.github/pull_request_template.md'])
})

test('install: 古い check.mjs は新しくする。status はそれを知らせる', () => {
  const repo = makeRepo()
  install(repo)
  assert.equal(status(repo).vendored_check, 'ok')
  writeFileSync(join(repo, VENDORED), '// old\n')
  assert.equal(status(repo).vendored_check, 'stale')
  assert.deepEqual(install(repo).updated, [VENDORED])
  assert.equal(status(makeRepo()).vendored_check, 'missing')
})

test('写した check.mjs はプラグインなしで動き、誤りで終了コード 1 を返す', () => {
  const repo = makeRepo()
  install(repo)
  const ok = spawnSync(process.execPath, [join(repo, VENDORED), repo], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /問題なし/)
  writeFiles(repo, { 'features/F-001-x.yaml': 'id: F-001\nstatus: planned\n' })
  const ng = spawnSync(process.execPath, [join(repo, VENDORED), repo, '--json'], { encoding: 'utf8' })
  assert.equal(ng.status, 1)
  assert.equal(JSON.parse(ng.stdout).ok, false)
  const id = spawnSync(process.execPath, [join(repo, VENDORED), 'next-id', 'feature', repo], { encoding: 'utf8' })
  assert.equal(id.stdout.trim(), 'F-002')
})

test('CLI: JSON で答える', () => {
  const repo = makeRepo()
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  const ins = run('install', repo, '--ci')
  assert.equal(ins.status, 0, ins.stderr)
  assert.ok(JSON.parse(ins.stdout).copied.includes('.github/workflows/feature-docs.yml'))
  assert.equal(JSON.parse(run('next-id', repo, 'req').stdout).id, 'REQ-0001')
  assert.equal(JSON.parse(run('status', repo).stdout).installed, true)
  assert.equal(JSON.parse(run('check', repo).stdout).ok, true)
  assert.deepEqual(JSON.parse(run('export-help', repo).stdout).written, ['docs/generated/help/index.json'])
  assert.ok(existsSync(JSON.parse(run('template', 'design').stdout).path))
  assert.throws(() => templatePath('nope'))
})

test('テンプレートはチェッカーで読める', () => {
  for (const f of ['feature.yaml', 'tracking.yaml', 'repo/actors.yaml', 'repo/glossary.yaml']) {
    assert.doesNotThrow(() => parseYamlSubset(readFileSync(join(TEMPLATES, f), 'utf8')), f)
  }
  const reqDoc = parseMarkdown(readFileSync(join(TEMPLATES, 'requirements.md'), 'utf8'))
  assert.equal(reqDoc.data.status, 'draft')
  for (const s of ['背景と課題', '目的とKPI', '誰が・いつ', '利用者の流れ', 'スコープ / 非ゴール', '受け入れ条件', '画面と状態']) assert.ok(reqDoc.headings.includes(s), s)
  const des = parseMarkdown(readFileSync(join(TEMPLATES, 'design.md'), 'utf8'))
  assert.ok(des.headings.includes('要件（EARS）'))
  assert.ok(des.headings.includes('受け入れ条件'))
  assert.deepEqual(des.data.pending, [])
})
