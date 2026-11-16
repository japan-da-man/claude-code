// user 単位のもの：好みの候補、掃除、user 側に置いたガードのテストケース。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { findRepo } from '../scripts/lib/core.mjs'
import { at, dataFiles, events, makeEnv, note, script, seedCandidates, session, writeFiles } from './helpers.mjs'

// 同じホーム・同じデータ領域で、もう 1 つのリポジトリを作る。
function secondRepo(t, name) {
  const repo = join(t.base, name)
  mkdirSync(join(repo, '.git'), { recursive: true })
  return { ...t, repo, name }
}
const idOf = (t) => findRepo(t.repo).id
const message = (run) => run.json?.systemMessage ?? ''
const startup = (t, id, now) => session(t, id).start('startup', { now })

test('好みの候補は user 単位で保存し、全リポジトリで数える（リポジトリごとに分けない）', () => {
  const a = makeEnv()
  const b = secondRepo(a, 'other-app')
  // 2 つのリポジトリで、別々のセッションが、同じ好みを 1 回ずつ記録する
  seedCandidates(a, 'prefers-short-answers', ['a1'], { category: 'behavior/preference' })
  seedCandidates(b, 'prefers-short-answers', ['b1', 'b2'], { category: 'behavior/preference' })
  seedCandidates(a, 'route-placement', ['a1'])
  // 置き場所は user 単位（_user）。リポジトリの候補とは分ける
  assert.deepEqual(dataFiles(a, 'candidates').map((f) => f.split('/')[0]).sort(), ['_user', '_user', '_user', idOf(a)])
  // どちらのリポジトリからも、同じ好みの候補が見える（どのリポジトリで出たかも分かる）
  for (const t of [a, b]) {
    const prefs = note(t, ['list', '--category', 'behavior/preference', '--json']).json
    assert.deepEqual(prefs.map((c) => [c.cause_key, c.repo]).sort(), [['prefers-short-answers', 'demo-app'], ['prefers-short-answers', 'other-app'], ['prefers-short-answers', 'other-app']], t.name)
  }
  // リポジトリの候補は、ほかのリポジトリからは見えない
  assert.deepEqual(note(b, ['list', '--category', 'dev/mistake', '--json']).json, [])
  // 件数は、全リポジトリの異なるセッションの数（どのリポジトリでも 3 件に届かないが、合わせて 3 件）
  const keys = note(b, ['keys', '--json']).json
  assert.deepEqual(keys.filter((k) => k.key === 'prefers-short-answers').map((k) => [k.key, k.sessions]), [['prefers-short-answers', 3]])
  for (const t of [a, b]) {
    assert.deepEqual(note(t, ['review', '--json', '--session', 'human-1']).json.preferences.map((p) => [p.cause_key, p.sessions]), [['prefers-short-answers', 3]], t.name)
  }
  // 好みは、自動改善の対象にしない
  assert.deepEqual(note(a, ['targets', '--json']).json.targets, [])
})

test('好みの候補の知らせは、リポジトリごとではなく、user 単位で 1 つ（1 回閉じれば、ほかのリポジトリでも出ない）', () => {
  const a = makeEnv()
  const b = secondRepo(a, 'other-app')
  const c = secondRepo(a, 'third-app')
  seedCandidates(a, 'prefers-short-answers', ['a1'], { category: 'behavior/preference' })
  seedCandidates(b, 'prefers-short-answers', ['b1', 'b0'], { category: 'behavior/preference' })
  const line = /重なった好みの候補が1件あります（prefers-short-answers）。\/self-improve:review で確かめて、合っていれば ~\/\.claude\/CLAUDE\.md に足せます。/
  // 閉じるまでは、どのリポジトリのセッション開始時にも出る
  assert.match(message(startup(a, 'a2', at(10))), line)
  assert.match(message(startup(c, 'c1', at(11))), line)
  // 1 回閉じれば、どのリポジトリでも出なくなる
  assert.match(note(c, ['report', 'close', '--session', 'c1'], { now: at(12) }).stdout, /閉じました/)
  for (const [t, id] of [[a, 'a3'], [b, 'b2'], [c, 'c2']]) assert.doesNotMatch(message(startup(t, id, at(20))), /好みの候補/, t.name)
  // 知らせの状態は、user 単位の 1 か所だけにある
  const state = JSON.parse(readFileSync(join(a.data, 'state', '_user', 'state.json'), 'utf8'))
  assert.deepEqual(Object.keys(state.notices).map((k) => k.split(':')[0]), ['preferences'])
  // 重なった好みの顔ぶれが変わったら、もう一度知らせる
  seedCandidates(c, 'prefers-pnpm', ['c3', 'c4', 'c5'], { category: 'behavior/preference', now: at(30) })
  assert.match(message(startup(b, 'b3', at(40))), /重なった好みの候補が2件あります/)
})

test('掃除は 1 日 1 回。データ領域にある全リポジトリの分を、リポジトリごとの保持期間で行う', () => {
  const a = makeEnv({ config: { episode_retention_days: 90 }, userFiles: { 'repos/short-app/config.json': { episode_retention_days: 10 } } })
  const b = secondRepo(a, 'short-app')
  const record = (t, id) => {
    const s = session(t, id)
    s.start('startup', { now: at(0) })
    s.prompt('p1', 'テストを直して', { now: at(1) })
    s.failed('p1', 'Bash', { command: 'npm test' }, 'Exit code 1', { now: at(2) })
    s.stop('p1', '直しました', { now: at(3) })
    note(t, ['add', '--session', id, '--category', 'dev/mistake', '--key', 'old-key', '--text', '古い候補'], { now: at(4) })
  }
  record(a, 'a1')
  record(b, 'b1')
  note(a, ['add', '--session', 'a1', '--category', 'behavior/preference', '--key', 'prefers-tabs', '--text', '古い好み'], { now: at(5) })
  const files = (t, kind) => dataFiles(t, kind).filter((f) => f.startsWith(`${idOf(t)}/`))
  for (const t of [a, b]) assert.deepEqual([files(t, 'episodes').length, files(t, 'events').length, files(t, 'candidates').length], [1, 1, 1], t.name)
  // 記録の更新時刻を、20 日前にする
  const old = new Date(Date.parse(at(0)) - 20 * 86_400_000)
  for (const kind of ['episodes', 'events']) for (const f of dataFiles(a, kind)) utimesSync(join(a.data, kind, f), old, old)

  // demo-app で始めたセッションが、開いていない short-app の分も掃除する（short-app の保持期間は 10 日）
  startup(a, 'a2', at(0, 12))
  assert.deepEqual([files(b, 'episodes').length, files(b, 'events').length, files(b, 'candidates').length], [0, 0, 0])
  // demo-app の分（90 日）と、user 単位の好みの候補（user の設定の 90 日）は残る
  assert.deepEqual([files(a, 'episodes').length, files(a, 'candidates').length], [1, 1])
  assert.equal(dataFiles(a, 'candidates').filter((f) => f.startsWith('_user/')).length, 1)
  const cleanedOn = () => JSON.parse(readFileSync(join(a.data, 'state', '_user', 'state.json'), 'utf8')).cleaned_on
  assert.equal(cleanedOn(), '2026-11-28')

  // 同じ日のうちは、もう掃除しない（どのリポジトリのセッションでも）
  note(b, ['add', '--session', 'b1', '--category', 'dev/mistake', '--key', 'old-key', '--text', '古い候補'], { now: at(0, -5) })
  assert.equal(files(b, 'candidates').length, 1)
  startup(b, 'b2', at(60, 12))
  startup(a, 'a3', at(120, 12))
  assert.equal(files(b, 'candidates').length, 1)
  // 日が変われば、次のセッション開始時に掃除する
  startup(a, 'a4', at(0, 13))
  assert.equal(files(b, 'candidates').length, 0)
  assert.equal(cleanedOn(), '2026-11-29')
  // 保持期間（90 日）を過ぎれば、好みの候補も消える
  startup(a, 'a5', at(0, 100))
  assert.deepEqual(dataFiles(a, 'candidates'), [])
})

test('掃除は startup のときだけ。resume・compact では行わない', () => {
  const t = makeEnv({ config: { episode_retention_days: 10 } })
  note(t, ['add', '--session', 's1', '--category', 'dev/mistake', '--key', 'old-key', '--text', '古い候補'], { now: at(0) })
  for (const source of ['resume', 'compact', 'clear']) session(t, 's2').start(source, { now: at(0, 20) })
  assert.equal(dataFiles(t, 'candidates').length, 1)
  startup(t, 's3', at(1, 20))
  assert.equal(dataFiles(t, 'candidates').length, 0)
})

test('test-guards: user 側に置いたガード（全リポジトリ用、リポジトリごと）のテストケースも実行する', () => {
  const t = makeEnv({
    userFiles: {
      'guards.json': { rules: [{ id: 'no-terraform-destroy', pattern: '\\bterraform\\s+destroy\\b', message: 'terraform destroy は実行しません。消すものを決めて、人が実行してください' }] },
      'guards.test.json': [
        { name: 'terraform destroy を止める', tool: 'Bash', input: { command: 'cd infra && terraform destroy -auto-approve' }, expect: 'deny' },
        { name: 'terraform plan は通す', tool: 'Bash', input: { command: 'terraform plan' }, expect: 'allow' },
      ],
      'repos/demo-app/guards.json': { rules: [{ id: 'ask-deploy', decision: 'ask', pattern: '^\\s*make\\s+deploy\\b', message: 'デプロイは、確かめてから実行します' }], protect: ['infra/'] },
      'repos/demo-app/guards.test.json': [
        { name: 'デプロイは確認を挟む', tool: 'Bash', input: { command: 'make deploy' }, expect: 'ask' },
        { name: '保護したパスは確認を挟む', tool: 'Write', input: { file_path: 'infra/main.tf' }, expect: 'ask' },
        { name: 'わざと外したテスト', tool: 'Bash', input: { command: 'make build' }, expect: 'ask' },
      ],
      // ほかのリポジトリ用のテストケースは、実行しない
      'repos/other-app/guards.test.json': [{ name: 'ほかのリポジトリ用', tool: 'Bash', input: { command: 'true' }, expect: 'deny' }],
    },
    files: { 'harness/guards.test.json': [{ name: 'リポジトリのテスト', tool: 'Bash', input: { command: 'ls' }, expect: 'allow' }] },
  })
  const run = spawnSync(process.execPath, [script('test-guards.mjs'), t.repo, '--json'], { encoding: 'utf8', env: t.env })
  assert.equal(run.status, 1, run.stderr)
  const result = JSON.parse(run.stdout)
  const own = result.results.filter((r) => r.source !== 'guards.default.test.json')
  assert.deepEqual(own.map((r) => [r.source, r.name, r.ok]), [
    ['~/.claude/self-improve/guards.test.json', 'terraform destroy を止める', true],
    ['~/.claude/self-improve/guards.test.json', 'terraform plan は通す', true],
    ['~/.claude/self-improve/repos/demo-app/guards.test.json', 'デプロイは確認を挟む', true],
    ['~/.claude/self-improve/repos/demo-app/guards.test.json', '保護したパスは確認を挟む', true],
    ['~/.claude/self-improve/repos/demo-app/guards.test.json', 'わざと外したテスト', false],
    ['harness/guards.test.json', 'リポジトリのテスト', true],
  ])
  // 共通リストのテストは、利用者のガードに左右されない場所で実行する（すべて通る）
  const defaults = result.results.filter((r) => r.source === 'guards.default.test.json')
  assert.ok(defaults.length >= 80 && defaults.every((r) => r.ok))
  // テストの実行は、何も記録しない（データ領域にも、user 側にも）
  assert.equal(existsSync(t.data), false)
  assert.deepEqual(readdirSync(t.user).sort(), ['guards.json', 'guards.test.json', 'repos'])
  assert.deepEqual(events(t), [])
})

test('test-guards: user 側で共通リストのルールを外していても、共通リストのテストは通る（空の設定で確かめるため）', () => {
  const t = makeEnv({ userFiles: { 'guards.json': { disable_defaults: ['no-verify', 'force-push'], rules: [] }, 'config.json': { exclude: [] } } })
  const run = spawnSync(process.execPath, [script('test-guards.mjs'), t.repo, '--json'], { encoding: 'utf8', env: t.env })
  assert.equal(run.status, 0, run.stdout.slice(-600))
  // 除外したリポジトリや、git リポジトリでない場所から実行しても、共通リストは確かめられる
  const none = makeEnv({ git: false })
  const outside = spawnSync(process.execPath, [script('test-guards.mjs'), none.repo], { encoding: 'utf8', env: none.env })
  assert.equal(outside.status, 0)
  assert.match(outside.stdout, /self-improve の動くリポジトリではないので、共通リストだけを実行しました/)
})
