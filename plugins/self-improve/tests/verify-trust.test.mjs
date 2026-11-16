// 検証コマンド（リポジトリの harness/config.json の verify）の許可（2.0.2）。
// クローンしただけのリポジトリの verify を、同意なしに実行しない。人が harness-note verify trust で許可した中身
// （正規化した JSON のハッシュ）と一致するときだけ実行し、中身が変われば、もう一度許可を求める。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { at, decisionOf, draft, finishAuto, guardRun, makeEnv, note, script, session, startAuto, writeFiles } from './helpers.mjs'

// 実行されると印のファイルを作る検証コマンドを、リポジトリに置く（許可はしない）。
const mark = (t) => join(t.base, 'verify-ran')
const place = (t, extra = []) => writeFiles(t.repo, { 'harness/config.json': { verify: [{ name: 'touch-mark', run: `touch "${mark(t)}"` }, ...extra] } })
// 変更のあったターンを 1 回流し、Stop の結果を返す。
function changedTurn(t, s, promptId, minute) {
  s.prompt(promptId, 'ファイルを直して', { now: at(minute) })
  s.used(promptId, 'Write', { file_path: join(t.repo, 'src/a.ts'), content: 'x' }, { now: at(minute + 1) })
  return s.stop(promptId, '直しました', { now: at(minute + 2) })
}

test('クローンしただけのリポジトリの verify は、許可するまで実行しない。セッション開始時に、許可の仕方を知らせる', () => {
  const t = makeEnv()
  place(t)
  const s = session(t)
  const start = s.start('startup', { now: at(0) })
  assert.match(start.json.systemMessage, /harness\/config\.json に検証コマンド（1 件：touch-mark）がありますが、まだ許可されていないので、実行していません/)
  assert.match(start.json.systemMessage, /harness-note verify trust/)
  const stop = changedTurn(t, s, 'p1', 1)
  assert.deepEqual([stop.status, existsSync(mark(t))], [0, false])
  // status と verify に、許可待ちと出る
  assert.match(note(t, ['status', '--session', 'sess-1']).stdout, /検証コマンド：1 件、許可待ち（実行していません/)
  const shown = note(t, ['verify', '--session', 'sess-1'])
  assert.match(shown.stdout, /1\. touch-mark：touch .*verify-ran"（制限時間 240 秒）\nまだ許可されていません。実行していません。許可するには harness-note verify trust を実行します。/)
  // 直接実行しても、許可されていなければ実行しない
  const direct = spawnSync(process.execPath, [script('verify.mjs'), t.repo], { encoding: 'utf8', env: t.env })
  assert.deepEqual([direct.status, existsSync(mark(t))], [1, false])
  assert.match(direct.stderr, /まだ許可されていないので、実行していません/)
})

test('harness-note verify trust：実行するコマンドの一覧を出してから記録し、そのあとは実行する。中身が変われば、もう一度許可が要る', () => {
  const t = makeEnv()
  place(t)
  const trusted = note(t, ['verify', 'trust', '--session', 'human-1'], { now: at(0) })
  assert.equal(trusted.status, 0)
  // 一覧が先、記録が後
  const list = trusted.stdout.indexOf('1. touch-mark：touch ')
  const recorded = trusted.stdout.indexOf('この中身を許可したと記録しました（~/.claude/self-improve/repos/demo-app/verify-trust.json）')
  assert.ok(list > 0 && recorded > list, trusted.stdout)
  // 記録は user 側の、リポジトリごとの置き場所に、リポジトリ ID ごとに残る（リポジトリには何も書かない）
  const record = JSON.parse(readFileSync(join(t.user, 'repos/demo-app/verify-trust.json'), 'utf8'))
  assert.deepEqual(Object.values(record.repos).map((r) => [r.repo, r.hash.length, r.verify.length]), [['demo-app', 64, 1]])
  // もう一度呼んでも、すでに許可済みと返すだけ
  assert.match(note(t, ['verify', 'trust', '--session', 'human-1']).stdout, /この中身は、すでに許可済みです/)

  const s = session(t)
  assert.equal(s.start('startup', { now: at(1) }).stdout, '')
  changedTurn(t, s, 'p1', 2)
  assert.equal(existsSync(mark(t)), true)
  assert.match(note(t, ['status', '--session', 'sess-1']).stdout, /検証コマンド：1 件、許可済み/)

  // プルなどで中身が変わったら、実行せず、もう一度許可を求める
  rmSync(mark(t))
  place(t, [{ name: 'lint', run: 'true' }])
  const again = session(t, 'sess-2')
  assert.match(again.start('startup', { now: at(10) }).json.systemMessage, /検証コマンド（2 件：touch-mark、lint）がありますが、前に許可したときから中身が変わっているので、実行していません/)
  changedTurn(t, again, 'p2', 11)
  assert.equal(existsSync(mark(t)), false)
  // 同じ名前の別のリポジトリ（ID が違う）は、許可を共有しない
  const other = makeEnv()
  writeFiles(other.user, { 'repos/demo-app/verify-trust.json': record })
  place(other)
  assert.equal(note(other, ['verify', '--json', '--session', 's']).json.trusted, false)
})

test('許可は人だけの操作：自動改善のセッション、実行中のほかのセッション、ロックを試みたセッション、セッションが推定のときは見送る', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7 } } })
  place(t)
  startAuto(t, ['route-placement'])
  const refused = (session, now) => note(t, ['verify', 'trust', ...(session ? ['--session', session] : [])], { now }).stdout
  assert.match(refused('auto-1', at(61)), /^見送り：自動改善のセッションでは/)
  assert.match(refused('human-1', at(61)), /^見送り：自動改善が実行中です/)
  draft(t, 'route-placement')
  finishAuto(t)
  assert.match(refused('auto-1', at(70)), /^見送り：このセッションは、自動改善（auto-improve）を呼び出したセッションです/)
  // --session を省くと、直近のセッション（ここでは auto-1）と推定され、やはり見送る
  assert.match(refused(null, at(70)), /^見送り：/)
  assert.equal(existsSync(join(t.user, 'repos/demo-app/verify-trust.json')), false)
  // 人のセッションからは、記録できる
  assert.match(refused('human-2', at(71)), /この中身を許可したと記録しました/)

  // セッションを確かめられないとき（推定）は、自動改善のセッションかどうかを見分けられないので、記録しない
  const plain = makeEnv()
  place(plain)
  assert.match(note(plain, ['verify', 'trust']).stdout, /^見送り：どのセッションからの操作かを確かめられないので、許可は記録しません/)
  assert.equal(existsSync(join(plain.user, 'repos/demo-app/verify-trust.json')), false)
})

test('ガード：harness-note verify trust には確認を挟み、実行するコマンドの一覧を見せる（許可ルールがあっても、人が決める）', () => {
  const t = makeEnv()
  place(t)
  const asked = guardRun(t, 'sess-1', 'Bash', { command: 'harness-note verify trust --session sess-1' })
  assert.equal(decisionOf(asked), 'ask')
  assert.match(asked.json.hookSpecificOutput.permissionDecisionReason, /検証コマンドの実行を許可します。許可すると、変更のあったターンの終わりに、確認なしで実行されます：1\. touch-mark：touch .*verify-ran"/)
  // 一覧を見るだけなら、確認は出さない
  assert.equal(decisionOf(guardRun(t, 'sess-1', 'Bash', { command: 'harness-note verify --session sess-1' })), 'allow')
  // 検証コマンドがなければ、許可するものもないので、確認も出さない
  const empty = makeEnv()
  assert.equal(decisionOf(guardRun(empty, 'sess-1', 'Bash', { command: 'harness-note verify trust --session sess-1' })), 'allow')
  // ロック中の自動改善のセッションでは、ガードは harness-note の呼び出しとして通し、harness-note 自身が見送る
  const auto = makeEnv({ config: { auto: { interval_days: 7 } } })
  place(auto)
  startAuto(auto, ['route-placement'])
  assert.equal(decisionOf(guardRun(auto, 'auto-1', 'Bash', { command: 'harness-note verify trust --session auto-1' }, { now: at(61) })), 'allow')
  assert.match(note(auto, ['verify', 'trust', '--session', 'auto-1'], { now: at(61) }).stdout, /^見送り：/)
})
