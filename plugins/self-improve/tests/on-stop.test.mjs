import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { at, dataFiles, events, makeEnv, note, readData, repoId, session } from './helpers.mjs'

const write = (t, s, promptId, file = 'src/a.ts', minute = 1) => s.used(promptId, 'Write', { file_path: join(t.repo, file), content: 'x' }, { now: at(minute) })
const counter = (t) => join(t.base, 'verify-runs.txt')
const runs = (t) => (existsSync(counter(t)) ? readFileSync(counter(t), 'utf8').trim().split('\n').length : 0)
// 走った回数を数え、リポジトリに ok.txt があれば通る検証コマンド
const verifyConfig = (t) => ({ verify: [{ name: 'typecheck', run: `echo run >> "${counter(t)}" && test -f ok.txt || { echo "src/a.ts(3,1): error TS2322 INC-2026-0012 を見てください"; exit 1; }` }] })

test('質問に答えただけのターン（信号も変更もない）では、何も起きない', () => {
  const t = makeEnv()
  const s = session(t)
  s.prompt('p1', 'この関数は何をしていますか', { now: at(0) })
  const run = s.stop('p1', '説明します…', { now: at(1) })
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', ''])
  assert.deepEqual(dataFiles(t, 'episodes'), [])
})

test('変更があったターン：改善候補の確認を 1 回だけ頼む（終了コード 2）。同じターンの 2 回目の Stop では頼まない', () => {
  const t = makeEnv()
  const s = session(t)
  s.prompt('p1', 'ユーザー一覧の API を足して', { now: at(0) })
  write(t, s, 'p1')
  const first = s.stop('p1', '足しました', { now: at(2) })
  assert.equal(first.status, 2)
  assert.equal(first.stdout, '')
  assert.match(first.stderr, /ターン終了時の確認です（エラーではありません）/)
  assert.match(first.stderr, /harness-note keys で既存の原因キーを確かめる/)
  assert.match(first.stderr, /harness-note add --session sess-1 --category <カテゴリ> --key <原因キー> --text "<1行>"/)
  assert.match(first.stderr, /dev\/bug \/ dev\/cause \/ dev\/mistake \/ dev\/other \/ behavior\/preference/)
  assert.match(first.stderr, /あと 3 件/)
  assert.match(first.stderr, /なければ何も記録せず/)
  // 信号はないので、事象メモは作らない
  assert.deepEqual(dataFiles(t, 'episodes'), [])

  // Claude が harness-note add を実行して、もう一度止まる。harness-note の実行は「変更あり」に数えない
  s.used('p1', 'Bash', { command: 'harness-note keys' }, { now: at(3) })
  s.used('p1', 'Bash', { command: 'harness-note add --session sess-1 --category dev/mistake --key route-placement --text "x"' }, { now: at(3) })
  const second = s.stop('p1', '記録しました', { now: at(4) }, { stop_hook_active: true })
  assert.deepEqual([second.status, second.stdout, second.stderr], [0, '', ''])
  // 何度止まっても、このターンではもう頼まない（stop_hook_active に頼らず、セッション ID とプロンプト ID の組で止める）
  assert.equal(s.stop('p1', 'x', { now: at(5) }).status, 0)
  assert.equal(events(t).filter((e) => e.type === 'asked').length, 1)

  // 次のターンで変更があれば、また 1 回頼む。別のセッションは別に数える
  s.prompt('p2', '続けて', { now: at(10) })
  write(t, s, 'p2', 'src/b.ts', 11)
  assert.equal(s.stop('p2', 'x', { now: at(12) }).status, 2)
  assert.equal(s.stop('p2', 'x', { now: at(13) }).status, 0)
})

test('harness-note だけ・読むだけのコマンドだけのターンでは、確認を頼まず、検証も走らせない', () => {
  const t = makeEnv()
  writeFileSync(join(t.repo, 'harness/config.json'), JSON.stringify(verifyConfig(t)))
  const s = session(t)
  s.prompt('p1', '改善候補を見せて', { now: at(0) })
  s.used('p1', 'Bash', { command: 'harness-note list' }, { now: at(1) })
  s.used('p1', 'Bash', { command: 'git status && ls src' }, { now: at(1) })
  const run = s.stop('p1', '一覧です', { now: at(2) })
  assert.deepEqual([run.status, run.stderr], [0, ''])
  assert.equal(runs(t), 0)
})

test('信号があったターン：事象メモを機械的に作り、確認の依頼に参照を添える', () => {
  const t = makeEnv()
  const s = session(t)
  s.prompt('p1', 'テストを直して', { now: at(0) })
  s.failed('p1', 'Bash', { command: 'npm test' }, "Exit code 1\nError: Cannot find module 'express'", { now: at(1) })
  const run = s.stop('p1', '依存が足りないので、入れてから再実行します', { now: at(2) })
  assert.equal(run.status, 2)
  const files = dataFiles(t, 'episodes')
  assert.equal(files.length, 1)
  const id = files[0].split('/')[1].replace('.md', '')
  assert.match(id, /^ep-20261116-090000-sess-1-[0-9a-f]{6}$/)
  assert.match(run.stderr, new RegExp(`--text "<1行>" --episode ${id}`))

  const memo = readData(t, 'episodes', files[0])
  assert.match(memo, /^session_id: sess-1$/m)
  assert.match(memo, /^prompt_id: p1$/m)
  assert.match(memo, /^signals: \[tool_failure\]$/m)
  assert.match(memo, /^transcript: \/tmp\/transcripts\/sess-1\.jsonl$/m)
  assert.match(memo, /## 依頼文\n\nテストを直して/)
  assert.match(memo, /- ツールの失敗：Bash（npm test） — Exit code 1/)
  assert.doesNotMatch(memo, /Cannot find module/)
  assert.match(memo, /## Claude の最後の応答\n\n依存が足りないので、入れてから再実行します/)

  // 候補から事象メモをたどれる
  const added = note(t, ['add', '--session', 'sess-1', '--category', 'dev/cause', '--key', 'missing-dependency', '--text', 'express を入れ忘れていた', '--episode', id], { now: at(3) })
  assert.match(added.stdout, /記録しました/)
  assert.match(note(t, ['episodes', 'missing-dependency']).stdout, /# 事象メモ ep-/)
  assert.match(note(t, ['list', '--json']).json[0].episode, /^ep-/)
  // 同じターンで何度止まっても、事象メモは 1 つ（書き直す）
  s.stop('p1', '入れました。テストは通りました', { now: at(4) })
  assert.equal(dataFiles(t, 'episodes').length, 1)
  assert.match(readData(t, 'episodes', files[0]), /入れました。テストは通りました/)
})

test('人の訂正：直前のターンの依頼文と応答を、訂正の内容とあわせて事象メモにする', () => {
  const t = makeEnv()
  const s = session(t)
  s.prompt('p1', 'ユーザー一覧の API を足して', { now: at(0) })
  write(t, s, 'p1', 'src/api/users.ts')
  s.stop('p1', 'src/api/users.ts に足しました', { now: at(2) })
  s.stop('p1', 'src/api/users.ts に足しました', { now: at(3) })

  s.prompt('p2', '違う、ルートは src/routes/ に置いて', { now: at(10) })
  write(t, s, 'p2', 'src/routes/users.ts', 11)
  const run = s.stop('p2', 'src/routes/users.ts に移しました', { now: at(12) })
  assert.equal(run.status, 2)
  // 同じターンの 2 回目の Stop で書き直しても、直前のターンは残る
  s.stop('p2', 'src/routes/users.ts に移しました', { now: at(13) })
  const files = dataFiles(t, 'episodes')
  assert.equal(files.length, 1)
  const memo = readData(t, 'episodes', files[0])
  assert.match(memo, /^signals: \[human_correction\]$/m)
  assert.match(memo, /## 依頼文\n\n違う、ルートは src\/routes\/ に置いて/)
  assert.match(memo, /- 人の訂正：「違う」/)
  assert.match(memo, /## 直前のターン（訂正の対象）\n\n### 依頼文\n\nユーザー一覧の API を足して\n\n### Claude の応答\n\nsrc\/api\/users\.ts に足しました/)
  assert.match(memo, /## Claude の最後の応答\n\nsrc\/routes\/users\.ts に移しました/)
})

test('検証：変更があったターンだけ走らせる。失敗したら検証の結果だけを返し、通ったあとの Stop で候補の確認を頼む', () => {
  const t = makeEnv()
  writeFileSync(join(t.repo, 'harness/config.json'), JSON.stringify(verifyConfig(t)))
  const s = session(t)
  s.prompt('p1', '型を直して', { now: at(0) })
  write(t, s, 'p1')
  const failed = s.stop('p1', '直しました', { now: at(2) })
  assert.equal(failed.status, 2)
  assert.match(failed.stderr, /検証「typecheck」.*が終了コード 1 で失敗しました。（連続 1 回目。3 回続くと打ち切ります）/)
  assert.match(failed.stderr, /error TS2322/)
  assert.match(failed.stderr, /関連する失敗票：INC-2026-0012/)
  // 検証が失敗したときは、候補の確認は頼まない
  assert.doesNotMatch(failed.stderr, /harness-note add/)
  assert.equal(events(t).filter((e) => e.type === 'asked').length, 0)
  // 検証の失敗は自分で記録し、事象メモにも入る
  const logged = events(t).find((e) => e.type === 'verify_failed')
  assert.deepEqual([logged.name, logged.streak, logged.incidents, logged.prompt_id], ['typecheck', 1, ['INC-2026-0012'], 'p1'])
  assert.match(readData(t, 'episodes', dataFiles(t, 'episodes')[0]), /- 検証の失敗：typecheck（連続 1 回目、関連する失敗票 INC-2026-0012）/)

  // Claude が直して、検証が通る → その Stop で候補の確認を頼む
  writeFileSync(join(t.repo, 'ok.txt'), '')
  write(t, s, 'p1', 'src/a.ts', 3)
  const passed = s.stop('p1', '直りました', { now: at(4) })
  assert.equal(passed.status, 2)
  assert.match(passed.stderr, /ターン終了時の確認です/)
  assert.equal(runs(t), 2)
  // 候補を記録して止まる。検証が通ったあとに変更はないので、検証は繰り返さない
  s.used('p1', 'Bash', { command: 'harness-note add --session sess-1 --category dev/mistake --key type-error --text "x"' }, { now: at(5) })
  assert.equal(s.stop('p1', '記録しました', { now: at(6) }).status, 0)
  assert.equal(runs(t), 2)

  // 変更のないターン（ツールの失敗だけ）では、検証を走らせない
  s.prompt('p2', 'ログを見て', { now: at(10) })
  s.failed('p2', 'Read', { file_path: join(t.repo, 'nope.log') }, 'File does not exist', { now: at(11) })
  s.stop('p2', 'ありませんでした', { now: at(12) })
  assert.equal(runs(t), 2)
})

test('検証の失敗が連続 3 回で打ち切り、人に知らせる（Claude には続けさせない）', () => {
  const t = makeEnv()
  writeFileSync(join(t.repo, 'harness/config.json'), JSON.stringify(verifyConfig(t)))
  const s = session(t)
  s.prompt('p1', '型を直して', { now: at(0) })
  write(t, s, 'p1')
  assert.match(s.stop('p1', '1', { now: at(2) }).stderr, /連続 1 回目/)
  write(t, s, 'p1', 'src/a.ts', 3)
  const second = s.stop('p1', '2', { now: at(4) })
  assert.equal(second.status, 2)
  assert.match(second.stderr, /連続 2 回目/)
  write(t, s, 'p1', 'src/a.ts', 5)
  const third = s.stop('p1', '3', { now: at(6) })
  assert.equal(third.status, 0)
  assert.equal(third.stderr, '')
  assert.match(third.json.systemMessage, /3 回続けて失敗したので、検証を打ち切りました/)
  assert.deepEqual(Object.keys(third.json), ['systemMessage'])
  // 打ち切ったターンでは、候補の確認も頼まない
  assert.equal(events(t).filter((e) => e.type === 'asked').length, 0)
  assert.deepEqual(events(t).filter((e) => e.type === 'verify_failed').map((e) => [e.streak, e.gave_up]), [[1, false], [2, false], [3, true]])
  assert.match(readData(t, 'episodes', dataFiles(t, 'episodes')[0]), /連続 3 回目、打ち切り/)

  // 打ち切ったら数え直す。次に変更があったターンでは、また 1 回目から
  s.prompt('p2', 'もう一度', { now: at(10) })
  write(t, s, 'p2', 'src/a.ts', 11)
  assert.match(s.stop('p2', 'x', { now: at(12) }).stderr, /連続 1 回目/)
  // 通れば 0 に戻る
  writeFileSync(join(t.repo, 'ok.txt'), '')
  write(t, s, 'p2', 'src/a.ts', 13)
  assert.match(s.stop('p2', 'x', { now: at(14) }).stderr, /ターン終了時の確認です/)
  rmSync(join(t.repo, 'ok.txt'))
  s.prompt('p3', 'さらに', { now: at(20) })
  write(t, s, 'p3', 'src/a.ts', 21)
  assert.match(s.stop('p3', 'x', { now: at(22) }).stderr, /連続 1 回目/)
})

test('1 ターンのあいだに続けさせる回数には、万一の上限がある', () => {
  const t = makeEnv()
  writeFileSync(join(t.repo, 'harness/config.json'), JSON.stringify(verifyConfig(t)))
  const s = session(t)
  const ok = join(t.repo, 'ok.txt')
  let minute = 0
  const stopAfterChange = () => {
    write(t, s, 'p1', 'src/a.ts', ++minute)
    return s.stop('p1', 'x', { now: at(++minute) })
  }
  s.prompt('p1', '直して', { now: at(0) })
  assert.equal(stopAfterChange().status, 2) // 失敗 1
  assert.equal(stopAfterChange().status, 2) // 失敗 2
  writeFileSync(ok, '')
  assert.match(stopAfterChange().stderr, /ターン終了時の確認/) // 通って、確認を頼む（3）
  rmSync(ok)
  assert.equal(stopAfterChange().status, 2) // 4
  assert.equal(stopAfterChange().status, 2) // 5
  writeFileSync(ok, '')
  assert.equal(stopAfterChange().status, 0) // 通る。確認は済んでいる
  rmSync(ok)
  assert.equal(stopAfterChange().status, 2) // 6
  const last = stopAfterChange()
  assert.equal(last.status, 0)
  assert.match(last.json.systemMessage, /繰り返されたので、このターンでは打ち切りました/)
})

test('そのセッションの候補が上限（3 件）に達していれば、確認を頼まない', () => {
  const t = makeEnv()
  const s = session(t)
  for (const [i, key] of ['key-one', 'key-two'].entries()) {
    note(t, ['add', '--session', 'sess-1', '--category', 'dev/mistake', '--key', key, '--text', 'x'], { now: at(i) })
  }
  s.prompt('p1', 'a', { now: at(10) })
  write(t, s, 'p1', 'src/a.ts', 11)
  assert.match(s.stop('p1', 'x', { now: at(12) }).stderr, /あと 1 件/)
  note(t, ['add', '--session', 'sess-1', '--category', 'dev/mistake', '--key', 'key-three', '--text', 'x'], { now: at(13) })
  s.prompt('p2', 'b', { now: at(20) })
  write(t, s, 'p2', 'src/a.ts', 21)
  const run = s.stop('p2', 'x', { now: at(22) })
  assert.deepEqual([run.status, run.stderr], [0, ''])
  // 信号があれば、事象メモは上限に関係なく作る
  s.prompt('p3', 'c', { now: at(30) })
  s.failed('p3', 'Bash', { command: 'npm test' }, 'Exit code 1', { now: at(31) })
  assert.equal(s.stop('p3', 'x', { now: at(32) }).status, 0)
  assert.equal(dataFiles(t, 'episodes').length, 1)
})

test('自動改善のセッションでは、検証も事象メモも候補の確認も動かさない', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7 } } })
  writeFileSync(join(t.repo, 'harness/config.json'), JSON.stringify({ auto: { interval_days: 7 }, ...verifyConfig(t) }))
  // ロックの前に記録された変更があっても（ロックの前のプロンプトなど）、ロック中は動かさない
  const s = session(t, 'auto-1')
  s.prompt('p1', 'auto-improve を実行して', { now: at(0) })
  write(t, s, 'p1')
  s.failed('p1', 'Bash', { command: 'npm test' }, 'Exit code 1', { now: at(1) })
  note(t, ['lock', '--session', 'auto-1'], { now: at(2) })
  const run = s.stop('p1', '終わりました', { now: at(3) })
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', ''])
  assert.equal(runs(t), 0)
  assert.deepEqual(dataFiles(t, 'episodes'), [])
  assert.equal(events(t).filter((e) => e.type === 'asked').length, 0)

  // 同じ時間の人のセッションは、ふだんどおり
  const human = session(t, 'human-1')
  human.prompt('h1', '直して', { now: at(4) })
  write(t, human, 'h1', 'src/a.ts', 5)
  assert.equal(human.stop('h1', 'x', { now: at(6) }).status, 2)
  assert.equal(runs(t), 1)
})

test('harness/config.json がないリポジトリと HARNESS_DISABLE=1 では、何もしない', () => {
  const none = makeEnv({ initialized: false })
  const n = session(none)
  n.used('p1', 'Write', { file_path: 'a' })
  const off = n.stop('p1', 'x')
  assert.deepEqual([off.status, off.stdout, off.stderr], [0, '', ''])
  assert.equal(existsSync(none.data), false)

  const t = makeEnv()
  const s = session(t)
  s.prompt('p1', 'a', { now: at(0) })
  write(t, s, 'p1')
  const disabled = s.stop('p1', 'x', { now: at(2), env: { HARNESS_DISABLE: '1' } })
  assert.deepEqual([disabled.status, disabled.stdout, disabled.stderr], [0, '', ''])
  // 止めていなければ頼む（同じ状態から）
  assert.equal(s.stop('p1', 'x', { now: at(3) }).status, 2)
})

test('prompt_id が渡らない版でも、ターンの始まりの時刻で区切って 1 回だけ頼む', () => {
  const t = makeEnv()
  const s = session(t)
  s.prompt(undefined, '最初の依頼', { now: at(0) })
  s.used(undefined, 'Write', { file_path: join(t.repo, 'a.ts') }, { now: at(1) })
  assert.equal(s.stop(undefined, 'x', { now: at(2) }).status, 2)
  assert.equal(s.stop(undefined, 'x', { now: at(3) }).status, 0)
  // 次のターンに変更がなければ、前のターンの変更は数えない
  s.prompt(undefined, '質問だけ', { now: at(10) })
  assert.equal(s.stop(undefined, 'x', { now: at(11) }).status, 0)
  s.prompt(undefined, 'もう一度変更', { now: at(20) })
  s.used(undefined, 'Edit', { file_path: join(t.repo, 'a.ts') }, { now: at(21) })
  assert.equal(s.stop(undefined, 'x', { now: at(22) }).status, 2)
  assert.ok(repoId(t))
})
