import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { install, writeIndex } from '../scripts/cli.mjs'

const CLI = fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url))
const TEMPLATES = fileURLToPath(new URL('../templates', import.meta.url))

const ACTORS = '| ID | 名前 | 説明 |\n| :- | :- | :- |\n| user | 利用者 | 使う人 |\n'
const FEATURE = '---\nid: task-create\nname: タスクを追加する\nstatus: 提供中\nactors: [user]\n---\n\n## 概要\n\n登録する。\n\n## 利用シーン\n\n- 思いついた → 残したい\n'

test('install creates docs/features with the actors and product templates and never overwrites them', () => {
  const repo = mkdtempSync(join(tmpdir(), 'fm-cli-'))
  const r = install(repo)
  assert.deepEqual(r.copied, ['docs/features/actors.md', 'docs/features/product.md'])
  assert.equal(r.template, join(TEMPLATES, 'feature.md'))
  assert.equal(readFileSync(join(repo, 'docs', 'features', 'actors.md'), 'utf8'), readFileSync(join(TEMPLATES, 'actors.md'), 'utf8'))
  writeFileSync(join(repo, 'docs', 'features', 'actors.md'), ACTORS)
  assert.deepEqual(install(repo).skipped, ['docs/features/actors.md', 'docs/features/product.md'])
  assert.equal(readFileSync(join(repo, 'docs', 'features', 'actors.md'), 'utf8'), ACTORS)
})

test('the feature template passes the check once its placeholders are filled', () => {
  const repo = mkdtempSync(join(tmpdir(), 'fm-cli-'))
  install(repo)
  writeFileSync(join(repo, 'docs', 'features', 'actors.md'), ACTORS)
  const filled = readFileSync(join(TEMPLATES, 'feature.md'), 'utf8')
    .replace('<id>', 'task-create')
    .replace('<機能名（〜する）>', 'タスクを追加する')
    .replace('<actor-id>', 'user')
    .replace(/related:\n(?:\s+.*\n)+?(?=---)/, '')
    .replace('<状況> → <したいこと>', '思いついた → 残したい')
    .replace('<!-- 何ができるかを', '登録する。\n<!-- 何ができるかを')
  writeFileSync(join(repo, 'docs', 'features', 'task-create.md'), filled)
  assert.equal(writeIndex(repo).written, 'docs/features/README.md')
  const p = spawnSync('node', [CLI, 'check', repo], { encoding: 'utf8' })
  assert.equal(p.status, 0, p.stdout)
  assert.deepEqual(JSON.parse(p.stdout).warnings, [])
})

test('index writes README.md only when there are no errors', () => {
  const repo = mkdtempSync(join(tmpdir(), 'fm-cli-'))
  install(repo)
  writeFileSync(join(repo, 'docs', 'features', 'actors.md'), ACTORS)
  writeFileSync(join(repo, 'docs', 'features', 'task-create.md'), FEATURE.replace('[user]', '[guest]'))
  const bad = writeIndex(repo)
  assert.equal(bad.written, null)
  assert.equal(bad.errors[0].rule, 'actors')
  assert.equal(existsSync(join(repo, 'docs', 'features', 'README.md')), false)
  writeFileSync(join(repo, 'docs', 'features', 'task-create.md'), FEATURE)
  assert.deepEqual(writeIndex(repo), { written: 'docs/features/README.md', features: 1, errors: [] })
})

test('the CLI prints JSON, and fails on unknown commands or a missing repo', () => {
  const repo = mkdtempSync(join(tmpdir(), 'fm-cli-'))
  let p = spawnSync('node', [CLI, 'install', repo], { encoding: 'utf8' })
  assert.equal(p.status, 0)
  assert.equal(JSON.parse(p.stdout).dir, 'docs/features')
  p = spawnSync('node', [CLI, 'check', repo], { encoding: 'utf8' })
  assert.equal(p.status, 1)
  p = spawnSync('node', [CLI, 'nope', repo], { encoding: 'utf8' })
  assert.equal(p.status, 1)
  assert.match(p.stderr, /使い方/)
  p = spawnSync('node', [CLI, 'check'], { encoding: 'utf8' })
  assert.equal(p.status, 1)
})
