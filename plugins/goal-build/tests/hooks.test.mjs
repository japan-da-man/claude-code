import { test } from 'node:test'
import assert from 'node:assert/strict'
import { utimesSync } from 'node:fs'
import { join } from 'node:path'
import { FEATURE_DIR, makeRepo, runHook } from './helpers.mjs'

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } })
const edit = (file_path) => ({ tool_name: 'Edit', tool_input: { file_path } })

// ---- guard-pr.sh ----

test('guard-pr: フローがなければ何もしない', () => {
  const { repo } = makeRepo({ active: false })
  const r = runHook('guard-pr.sh', repo, bash('gh pr create --fill'))
  assert.equal(r.status, 0)
})

test('guard-pr: 実行中は gh pr create / merge を、書き方を変えても止める', () => {
  const { repo } = makeRepo()
  for (const cmd of [
    'gh pr create --fill',
    'gh pr merge 12 --squash',
    'gh -R owner/repo pr create --title x',
    'gh --repo=owner/repo pr create',
    'bash -c "gh pr create --fill"',
    'git push && gh pr create --fill',
    '/usr/local/bin/gh pr create',
    'echo ok; gh pr create',
    'out=$(gh pr create --fill)',
  ]) {
    const r = runHook('guard-pr.sh', repo, bash(cmd))
    assert.equal(r.status, 2, cmd)
    assert.match(r.stderr, /PR の作成とマージを禁止/, cmd)
  }
})

test('guard-pr: push や他の gh コマンドは止めない', () => {
  const { repo } = makeRepo()
  for (const cmd of [
    'git push -u origin feat/rate-limit',
    'git -C . push',
    'gh pr view 12',
    'gh pr list',
    'gh pr checks',
    'gh issue create --title x',
    'pnpm vitest run',
  ]) {
    const r = runHook('guard-pr.sh', repo, bash(cmd))
    assert.equal(r.status, 0, cmd)
  }
})

// ---- guard-spec.sh ----

test('guard-spec: 実行中の機能の SPEC.md（絶対パス・相対パス）の編集を止める', () => {
  const { repo } = makeRepo()
  for (const p of [join(repo, FEATURE_DIR, 'SPEC.md'), `${FEATURE_DIR}/SPEC.md`, `./${FEATURE_DIR}/SPEC.md`]) {
    const r = runHook('guard-spec.sh', repo, edit(p))
    assert.equal(r.status, 2, p)
    assert.match(r.stderr, /編集できません/)
  }
})

test('guard-spec: 他の機能の SPEC.md や、同じ機能の他のファイルは止めない', () => {
  const { repo } = makeRepo()
  for (const p of [
    join(repo, 'docs/specs/other/SPEC.md'),
    join(repo, FEATURE_DIR, 'PROGRESS.md'),
    join(repo, FEATURE_DIR, 'QUESTIONS.md'),
    join(repo, 'src/app.ts'),
  ]) {
    assert.equal(runHook('guard-spec.sh', repo, edit(p)).status, 0, p)
  }
})

test('guard-spec: フローがなければ SPEC.md も編集できる（設計フェーズ）', () => {
  const { repo } = makeRepo({ active: false })
  assert.equal(runHook('guard-spec.sh', repo, edit(join(repo, FEATURE_DIR, 'SPEC.md'))).status, 0)
})

// ---- run-checks.sh ----

test('run-checks: フローがなければ何もしない（チェックも走らない）', () => {
  const env = makeRepo({ active: false })
  const r = runHook('run-checks.sh', env.repo)
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
  assert.equal(env.runs(), 0)
})

test('run-checks: チェックが通れば終われる。変更がなければ次は省略する', () => {
  const env = makeRepo()
  env.setCheck('pass')
  let r = runHook('run-checks.sh', env.repo)
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
  assert.equal(env.runs(), 1)
  assert.ok(env.read('.goal-build/last-pass'))
  r = runHook('run-checks.sh', env.repo)
  assert.equal(r.stdout, '')
  assert.equal(env.runs(), 1, '変更がないので check.sh は走らない')
})

test('run-checks: 未追跡ファイルの中身が変わっただけでも、チェックし直す', () => {
  const env = makeRepo()
  env.setCheck('pass')
  env.write({ 'src/new.ts': 'export const a = 1\n' })
  runHook('run-checks.sh', env.repo)
  assert.equal(env.runs(), 1)
  env.write({ 'src/new.ts': 'export const a = 2\n' })
  runHook('run-checks.sh', env.repo)
  assert.equal(env.runs(), 2)
})

test('run-checks: 失敗すると stdout の JSON で終了を拒否し、出力の末尾を返す', () => {
  const env = makeRepo()
  env.setCheck('fail:No such file or directory: missing.ts')
  const r = runHook('run-checks.sh', env.repo)
  assert.equal(r.status, 0)
  assert.equal(r.json?.decision, 'block')
  assert.match(r.json.reason, /No such file or directory/)
  assert.match(r.json.reason, /1\/3/)
  assert.equal(env.read('.goal-build/stop-count'), '1')
})

test('run-checks: 同じ失敗が 3 回続くと blocked にし、その後は終われる', () => {
  const env = makeRepo()
  env.setCheck('fail:db is down')
  runHook('run-checks.sh', env.repo)
  runHook('run-checks.sh', env.repo)
  const third = runHook('run-checks.sh', env.repo)
  assert.equal(third.json?.decision, 'block')
  assert.match(third.json.reason, /blocked にしました/)
  assert.equal(env.read('.goal-build/state'), 'blocked')
  const fourth = runHook('run-checks.sh', env.repo)
  assert.equal(fourth.status, 0)
  assert.equal(fourth.stdout, '')
  assert.equal(env.runs(), 3, 'blocked の間はチェックしない')
})

test('run-checks: 失敗の中身が変われば数え直す（作業が進んでいる間は blocked にしない）', () => {
  const env = makeRepo()
  env.setCheck('fail:test A')
  runHook('run-checks.sh', env.repo)
  runHook('run-checks.sh', env.repo)
  env.setCheck('fail:test B')
  const r = runHook('run-checks.sh', env.repo)
  assert.match(r.json.reason, /1\/3/)
  assert.equal(env.read('.goal-build/state'), 'implementing')
})

test('run-checks: 通ったら失敗の数を消す', () => {
  const env = makeRepo()
  env.setCheck('fail:x')
  runHook('run-checks.sh', env.repo)
  env.setCheck('pass')
  env.write({ 'src/app.ts': 'export const app = 2\n' })
  runHook('run-checks.sh', env.repo)
  assert.equal(env.read('.goal-build/stop-count'), null)
  assert.equal(env.read('.goal-build/fail-hash'), null)
})

test('run-checks: 承認済みの SPEC.md が書き換えられていたら、チェックより先に止める', () => {
  const env = makeRepo()
  env.setCheck('pass')
  env.write({ [`${FEATURE_DIR}/SPEC.md`]: '---\nstatus: approved\n---\n# spec (edited)\n' })
  const r = runHook('run-checks.sh', env.repo)
  assert.equal(r.json?.decision, 'block')
  assert.match(r.json.reason, /承認時/)
  assert.match(r.json.reason, new RegExp(env.approved))
  assert.equal(env.runs(), 0)
})

test('run-checks: reported の最終ターンもチェックする', () => {
  const env = makeRepo({ state: 'reported' })
  env.setCheck('fail:late failure')
  const r = runHook('run-checks.sh', env.repo)
  assert.equal(r.json?.decision, 'block')
})

test('run-checks: check.sh がなければ何もしない', () => {
  const env = makeRepo({ check: false })
  const r = runHook('run-checks.sh', env.repo)
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

// ---- session-context.sh ----

test('session-context: フローがなければ何も出さない', () => {
  const { repo } = makeRepo({ active: false })
  assert.equal(runHook('session-context.sh', repo).stdout, '')
})

test('session-context: implementing なら未完了のタスクと続きの場所を出す', () => {
  const { repo } = makeRepo()
  const out = runHook('session-context.sh', repo).stdout
  assert.match(out, /実行中: docs\/specs\/rate-limit/)
  assert.match(out, /AC-1 の 429 応答 \/ AC-2 \/ ヘッダー/)
  assert.doesNotMatch(out, /AC-1 の土台/)
  assert.match(out, /手順 2/)
})

test('session-context: blocked・reported ではそれぞれの案内を出す', () => {
  assert.match(runHook('session-context.sh', makeRepo({ state: 'blocked' }).repo).stdout, /blocked です。.*QUESTIONS\.md/)
  assert.match(runHook('session-context.sh', makeRepo({ state: 'reported' }).repo).stdout, /報告済み.*goal-build:finish/)
})

test('session-context: 24 時間以上前のフローには警告を出す', () => {
  const { repo } = makeRepo()
  const old = new Date(Date.now() - 2 * 86_400_000)
  utimesSync(join(repo, '.goal-build/active'), old, old)
  assert.match(runHook('session-context.sh', repo).stdout, /24 時間以上前/)
})
