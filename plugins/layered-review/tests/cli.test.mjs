import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VENDORED, codeowners, install, newRun, outcomeAdd, roundBegin, roundRecord, roundReset, roundStats, status } from '../scripts/cli.mjs'
import { loadConfig, readOutcomes, runCheck } from '../scripts/check.mjs'
import { makeGitRepo, makeRepo, writeFiles } from './helpers.mjs'

const CLI = fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url))

test('install: check.mjs を写し、設定とひな形を置く。2 回目は何も上書きしない', () => {
  const repo = makeRepo({ 'REVIEW.md': '# 既存\n' })
  const first = install(repo)
  assert.ok(first.copied.includes(VENDORED))
  assert.ok(first.copied.includes('review/config.json'))
  assert.ok(first.copied.includes('review/README.md'))
  assert.ok(first.copied.includes('review/evals/cases/.gitkeep'))
  assert.ok(first.skipped.includes('REVIEW.md'))
  assert.equal(readFileSync(join(repo, 'REVIEW.md'), 'utf8'), '# 既存\n')
  assert.equal(existsSync(join(repo, '.github/workflows/layered-review.yml')), false)
  assert.equal(loadConfig(repo).config.approvals.high_needs_other, true)
  assert.equal(runCheck(repo).ok, true)

  const second = install(repo, { ci: true, prTemplate: true })
  assert.deepEqual(second.updated, [])
  assert.deepEqual(second.copied, ['.github/workflows/layered-review.yml', '.github/pull_request_template.md'])
  assert.equal(status(repo).ci, true)
})

test('install: 1 人の開発なら高リスクでも作者が確かめる。古い check.mjs は新しくする', () => {
  const repo = makeRepo()
  install(repo, { solo: true })
  assert.equal(loadConfig(repo).config.approvals.high_needs_other, false)
  assert.equal(status(repo).vendored_check, 'ok')
  writeFileSync(join(repo, VENDORED), '// old\n')
  assert.equal(status(repo).vendored_check, 'stale')
  assert.deepEqual(install(repo).updated, [VENDORED])
  assert.equal(status(makeRepo()).vendored_check, 'missing')
})

test('写した check.mjs はプラグインなしで動く', () => {
  const repo = makeRepo()
  install(repo)
  const r = spawnSync(process.execPath, [join(repo, VENDORED), repo], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /問題なし/)
})

test('codeowners: 高リスクのパスから作る。すでにあれば足す行を返して書かない', () => {
  const repo = makeRepo()
  install(repo)
  writeFiles(repo, { 'review/config.json': { risk: { high: { 課金: ['**/iap/**'], CI: ['.github/workflows/**'] } } } })
  const r = codeowners(repo, '@nao')
  assert.deepEqual(r, { path: '.github/CODEOWNERS', written: true })
  const text = readFileSync(join(repo, '.github/CODEOWNERS'), 'utf8')
  assert.match(text, /^\*\*\/iap\/\*\* @nao$/m)
  assert.match(text, /^\.github\/workflows\/\*\* @nao$/m)
  const again = codeowners(repo, '@org/team')
  assert.equal(again.written, false)
  assert.match(again.append, /@org\/team/)
  assert.throws(() => codeowners(repo, 'nao'), /--owner/)
})

test('round: 1 回目は全体、2 回目からは前回からの差分。重複は数えず、Important がなくなったら通過', () => {
  const repo = makeGitRepo()
  const b1 = roundBegin(repo, { branch: 'feat/x', head: 'h1', base: 'm0' })
  assert.deepEqual([b1.round, b1.scope, b1.diff_base, b1.over_cap], [1, 'full', 'm0', false])

  const file = join(repo, '..', `round-${Date.now()}.json`)
  const imp = { path: 'a.ts', line: 3, class: 'null', title: 'null で落ちる', severity: 'high', label: 'important' }
  writeFileSync(file, JSON.stringify({ findings: [imp, { path: 'a.ts', line: 9, class: 'name', title: '名前', label: 'nit' }] }))
  const r1 = roundRecord(repo, { branch: 'feat/x', head: 'h1', base: 'm0', file })
  assert.deepEqual([r1.round, r1.new_findings, r1.open_important, r1.passed], [1, 2, 1, false])

  // 同じ head でもう一度始めても、回数は増えない
  const again = roundBegin(repo, { branch: 'feat/x', head: 'h1', base: 'm0' })
  assert.equal(again.unchanged, true)
  assert.equal(again.round, 1)

  const b2 = roundBegin(repo, { branch: 'feat/x', head: 'h2', base: 'm0' })
  assert.deepEqual([b2.round, b2.scope, b2.diff_base], [2, 'diff', 'h1'])
  assert.equal(b2.previous_open.length, 1)
  assert.equal(b2.reported.length, 2)

  // 前回と同じ指摘は足さない。前回の Important が直れば通過
  writeFileSync(file, JSON.stringify({ findings: [{ ...imp, title: 'null で落ちる。' }], previous: [{ fp: b2.previous_open[0].fp, status: 'fixed' }] }))
  const r2 = roundRecord(repo, { branch: 'feat/x', head: 'h2', base: 'h1', file })
  assert.deepEqual([r2.round, r2.new_findings, r2.skipped_duplicates, r2.passed, r2.passed_round], [2, 0, 1, true, 2])

  writeFileSync(file, JSON.stringify({ findings: [] }))
  roundRecord(repo, { branch: 'feat/x', head: 'h3', file })
  const b4 = roundBegin(repo, { branch: 'feat/x', head: 'h4', base: 'm0' })
  assert.deepEqual([b4.round, b4.over_cap], [4, true])

  const s = roundStats(repo)
  assert.deepEqual([s.branches, s.passed, s.avg_rounds_to_pass, s.max_rounds], [1, 1, 2, 3])
  assert.deepEqual(roundReset(repo, { branch: 'feat/x' }), { reset: true })
  assert.equal(roundBegin(repo, { branch: 'feat/x', head: 'h4', base: 'm0' }).round, 1)
  // 状態は git のディレクトリに置き、作業ツリーを汚さない
  assert.ok(existsSync(join(repo, '.git/layered-review/state.json')))

  writeFileSync(file, JSON.stringify({ findings: [{ ...imp, label: 'must' }] }))
  assert.throws(() => roundRecord(repo, { branch: 'y', head: 'h', file }), /label/)
})

test('eval new-run と outcome add: 実行の置き場所を作り、対応結果を足す', () => {
  const repo = makeGitRepo({ 'REVIEW.md': '# r\n' })
  const { dir } = newRun(repo, { label: 'baseline', note: '最初' })
  assert.match(dir, /^review\/evals\/runs\/\d{8}-\d{6}-baseline$/)
  const meta = JSON.parse(readFileSync(join(repo, dir, 'run.json'), 'utf8'))
  assert.equal(meta.label, 'baseline')
  assert.ok(meta.review_md_sha1)
  assert.ok(existsSync(join(repo, dir, 'findings')))
  assert.throws(() => newRun(repo, { label: 'a b' }), /--label/)

  const file = join(repo, '..', `out-${Date.now()}.json`)
  writeFileSync(file, JSON.stringify([{ ref: '#12', class: 'null', severity: 'high', title: 'x', outcome: 'intentional', reason: '仕様' }]))
  assert.deepEqual(outcomeAdd(repo, { file }), { added: 1, path: 'review/outcomes.jsonl' })
  outcomeAdd(repo, { file })
  assert.equal(readOutcomes(repo).rows.length, 2)
  writeFileSync(file, JSON.stringify([{ outcome: 'maybe' }]))
  assert.throws(() => outcomeAdd(repo, { file }), /outcome/)
})

test('cli.mjs: 旗はあとの引数を食べない。知らないコマンドは終了コード 2', () => {
  const repo = makeRepo()
  const r = spawnSync(process.execPath, [CLI, 'install', '--ci', repo, '--solo'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(JSON.parse(r.stdout).copied.includes('.github/workflows/layered-review.yml'))
  assert.equal(loadConfig(repo).config.approvals.high_needs_other, false)
  assert.equal(spawnSync(process.execPath, [CLI, 'nope'], { encoding: 'utf8' }).status, 2)
  const id = spawnSync(process.execPath, [CLI, 'eval', 'new-id', repo], { encoding: 'utf8' })
  assert.deepEqual(JSON.parse(id.stdout), { id: 'C-001' })
})
