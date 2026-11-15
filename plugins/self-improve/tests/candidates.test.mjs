import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isSimilarKey } from '../scripts/lib/candidates.mjs'
import { at, dataFiles, makeEnv, note, seedCandidates } from './helpers.mjs'

const add = (t, session, key, text, opts = {}, category = 'dev/mistake') =>
  note(t, ['add', '--session', session, '--category', category, '--key', key, '--text', text], opts)

test('add: カテゴリ・原因キー・1 行の内容・セッション ID を、状態 new で記録する', () => {
  const t = makeEnv()
  const run = add(t, 'sess-1', 'route-placement', '  ルート定義を   src/api に作ってしまった  ', { now: at(0) })
  assert.equal(run.status, 0)
  assert.match(run.stdout, /記録しました/)
  const list = note(t, ['list', '--json']).json
  assert.equal(list.length, 1)
  assert.equal(list[0].category, 'dev/mistake')
  assert.equal(list[0].cause_key, 'route-placement')
  assert.equal(list[0].text, 'ルート定義を src/api に作ってしまった')
  assert.equal(list[0].session_id, 'sess-1')
  assert.equal(list[0].status, 'new')
  assert.equal(list[0].at, at(0))
  assert.deepEqual(dataFiles(t, 'candidates').length, 1)
})

test('add: カテゴリと原因キーの形を検査する', () => {
  const t = makeEnv()
  assert.equal(add(t, 's', 'route-placement', 'x', {}, 'dev/unknown').status, 1)
  assert.equal(add(t, 's', 'Route Placement', 'x').status, 1)
  assert.equal(add(t, 's', 'ab', 'x').status, 1)
  assert.equal(note(t, ['add', '--session', 's', '--category', 'dev/bug', '--key', 'some-key']).status, 1)
  assert.equal(note(t, ['add', '--session', 's', '--category', 'dev/bug', '--key', 'some-key', '--text', '1行目\n2行目']).status, 1)
  assert.equal(note(t, ['add', '--session', 's', '--category', 'dev/bug', '--key', 'some-key', '--text', 'x', '--allowed-tools', 'Bash']).status, 1)
  assert.deepEqual(dataFiles(t, 'candidates'), [])
  // カテゴリは config.json で変えられる
  const custom = makeEnv({ config: { candidates: { categories: ['ops/incident'] } } })
  assert.match(add(custom, 's', 'some-key', 'x', {}, 'ops/incident').stdout, /記録しました/)
  assert.equal(add(custom, 's', 'some-key-2', 'x', {}, 'dev/bug').status, 1)
})

test('件数は「異なるセッションの数」で数える。1 つのセッションで何度書いても 1 件', () => {
  const t = makeEnv()
  add(t, 'sess-1', 'route-placement', '1回目', { now: at(0) })
  add(t, 'sess-1', 'route-placement', '同じセッションで後からもう一度', { now: at(30) })
  let keys = note(t, ['keys', '--json']).json
  assert.equal(keys[0].sessions, 1)
  assert.equal(keys[0].new, 2)
  assert.deepEqual(note(t, ['targets', '--json']).json.targets, [])

  add(t, 'sess-2', 'route-placement', '別のセッションでも起きた', { now: at(60) })
  keys = note(t, ['keys', '--json']).json
  assert.equal(keys[0].sessions, 2)
  assert.deepEqual(note(t, ['targets', '--json']).json.targets.map((x) => x.key), ['route-placement'])
})

test('1 セッション 3 件まで。上限を超えた分は記録せず、終了してよいと返す', () => {
  const t = makeEnv()
  for (const [i, key] of ['key-one', 'key-two', 'key-three'].entries()) {
    assert.match(add(t, 'sess-1', key, `気づき ${i}`, { now: at(i) }).stdout, /記録しました/)
  }
  const over = add(t, 'sess-1', 'key-four', '4 件目', { now: at(5) })
  assert.equal(over.status, 0)
  assert.match(over.stdout, /記録しません：このセッションの上限（3 件）/)
  assert.equal(note(t, ['list', '--json']).json.length, 3)
  // 別のセッションは別に数える
  assert.match(add(t, 'sess-2', 'key-four', '別セッション', { now: at(6) }).stdout, /記録しました/)
})

test('短時間の重複記録：同じセッション・同じキーの続けての記録は、二重に数えず、上限も消費しない', () => {
  const t = makeEnv()
  add(t, 'sess-1', 'route-placement', '1回目', { now: at(0) })
  const again = add(t, 'sess-1', 'route-placement', '言い直し', { now: at(3) })
  assert.equal(again.status, 0)
  assert.match(again.stdout, /記録しません：同じ原因キー/)
  // セッション ID が違っても、同じキー・同じ文面が続けて来たら重複（再実行など）
  const retry = add(t, 'sess-other', 'route-placement', '1回目', { now: at(4) })
  assert.match(retry.stdout, /記録しません：同じ原因キー/)
  assert.equal(note(t, ['list', '--json']).json.length, 1)
  // 重複は上限に数えないので、あと 2 件は記録できる
  assert.match(add(t, 'sess-1', 'key-two', 'x', { now: at(5) }).stdout, /あと 1 件/)
  // 時間がたてば、同じセッションでも別の記録として残る（セッション数は 1 のまま）
  assert.match(add(t, 'sess-1', 'route-placement', '11 分後', { now: at(11) }).stdout, /記録しました/)
  assert.equal(note(t, ['keys', '--json']).json.find((k) => k.key === 'route-placement').sessions, 1)
})

test('似たキーが既にあるときは警告し、rekey でまとめ直せる', () => {
  const t = makeEnv()
  add(t, 'sess-1', 'route-placement', 'a', { now: at(0) })
  const same = add(t, 'sess-2', 'route-placement', 'b', { now: at(1) })
  assert.doesNotMatch(same.stdout, /警告/)
  const similar = add(t, 'sess-3', 'routes-placement', 'c', { now: at(2) })
  assert.match(similar.stdout, /記録しました/)
  assert.match(similar.stdout, /警告：似た原因キーが既にあります：route-placement/)
  assert.match(similar.stdout, /harness-note rekey routes-placement route-placement/)
  assert.doesNotMatch(add(t, 'sess-3', 'migration-forgotten', 'd', { now: at(3) }).stdout, /警告/)

  assert.match(note(t, ['rekey', 'routes-placement', 'route-placement']).stdout, /1 件の候補/)
  const keys = note(t, ['keys', '--json']).json
  assert.equal(keys.find((k) => k.key === 'route-placement').sessions, 3)
  assert.equal(keys.find((k) => k.key === 'routes-placement'), undefined)
})

test('isSimilarKey: 並び替え・複数形・前方一致・1〜2 文字の違いを似ていると見なす', () => {
  assert.equal(isSimilarKey('route-placement', 'placement-route'), true)
  assert.equal(isSimilarKey('route-placement', 'routes-placement'), true)
  assert.equal(isSimilarKey('route-placement', 'route-placement-hono'), true)
  assert.equal(isSimilarKey('route-placement', 'route-placment'), true)
  assert.equal(isSimilarKey('route-placement', 'route-placement'), false)
  assert.equal(isSimilarKey('route-placement', 'migration-forgotten'), false)
  assert.equal(isSimilarKey('env-edit', 'type-error'), false)
})

test('状態：consumed と rejected は件数に数えない。断られた原因は、そのあとの候補が新たにたまるまで対象にしない', () => {
  const t = makeEnv()
  seedCandidates(t, 'route-placement', ['s1', 's2', 's3'], { now: at(0) })
  assert.equal(note(t, ['targets', '--json']).json.targets[0].sessions, 3)

  // 人が「消す」を選んだ（断られた）
  assert.match(note(t, ['mark', '--key', 'route-placement', '--status', 'rejected'], { now: at(10) }).stdout, /「断られた」と記録しました（数えなくなる候補 3 件）/)
  assert.deepEqual(note(t, ['targets', '--json']).json.targets, [])
  const key = note(t, ['keys', '--json']).json[0]
  assert.equal(key.sessions, 0)
  assert.equal(key.rejected, 3)
  assert.ok(key.rejected_at)

  // 断られたあと、新しい候補が 1 件では対象にならない。2 件（異なるセッション）で、また対象になる
  seedCandidates(t, 'route-placement', ['s4'], { now: at(20) })
  assert.deepEqual(note(t, ['targets', '--json']).json.targets, [])
  seedCandidates(t, 'route-placement', ['s5'], { now: at(21) })
  const targets = note(t, ['targets', '--json']).json.targets
  assert.equal(targets.length, 1)
  assert.equal(targets[0].sessions, 2)

  // consumed も数えない
  const ids = note(t, ['list', '--json']).json.map((c) => c.id)
  assert.match(note(t, ['mark', ...ids, '--status', 'consumed']).stdout, /2 件を consumed/)
  assert.deepEqual(note(t, ['targets', '--json']).json.targets, [])
  assert.equal(note(t, ['list', '--status', 'all', '--json']).json.length, 5)
})

test('自動改善の対象は dev/cause と dev/mistake だけ。件数の多い順、同数なら新しい順', () => {
  const t = makeEnv()
  seedCandidates(t, 'older-two', ['a1', 'a2'], { now: at(0) })
  seedCandidates(t, 'newer-two', ['b1', 'b2'], { now: at(20), category: 'dev/cause' })
  seedCandidates(t, 'three-sessions', ['c1', 'c2', 'c3'], { now: at(40) })
  seedCandidates(t, 'a-bug', ['d1', 'd2', 'd3', 'd4'], { now: at(60), category: 'dev/bug' })
  seedCandidates(t, 'likes-short-answers', ['e1', 'e2', 'e3'], { now: at(80), category: 'behavior/preference' })
  seedCandidates(t, 'only-once', ['f1'], { now: at(100) })
  const { targets } = note(t, ['targets', '--json']).json
  assert.deepEqual(targets.map((x) => x.key), ['three-sessions', 'newer-two', 'older-two'])
  assert.deepEqual(targets.map((x) => x.mode), ['new', 'new', 'new'])
})

test('自動改善のセッションでは add を受け付けず、「何もせず終了してよい」と返す', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7 } } })
  assert.match(note(t, ['lock', '--session', 'auto-1'], { now: at(0) }).stdout, /自動改善を開始しました/)
  const run = add(t, 'auto-1', 'route-placement', 'ハーネス自身の作業', { now: at(1) })
  assert.equal(run.status, 0)
  assert.match(run.stdout, /何もせず終了してよい/)
  assert.deepEqual(dataFiles(t, 'candidates'), [])
  // 同じ時間に人が別のセッションで作業していても、そちらの記録は止まらない
  assert.match(add(t, 'human-1', 'route-placement', '人のセッション', { now: at(2) }).stdout, /記録しました/)
  // 2 時間たったロックは無効
  assert.match(add(t, 'auto-1', 'route-placement', '失効後', { now: at(125) }).stdout, /記録しました/)
})

test('add: 事象メモの参照は、実在するものだけ付ける', () => {
  const t = makeEnv()
  const run = note(t, ['add', '--session', 's1', '--category', 'dev/bug', '--key', 'some-bug', '--text', 'x', '--episode', 'ep-missing'])
  assert.match(run.stdout, /事象メモ ep-missing が見つからない/)
  assert.equal(note(t, ['list', '--json']).json[0].episode, null)
  assert.equal(existsSync(join(t.data, 'episodes')), false)
})
