import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, at, dataFiles, decisionOf, events, guardRun, makeEnv, note, readData, repoId, session, writeFiles } from './helpers.mjs'

// 失敗の信号（ツールの失敗）。改善候補の確認は、信号があったターンだけ頼む。
const signal = (s, promptId, minute = 1) => s.failed(promptId, 'Bash', { command: 'npm test' }, 'Exit code 1', { now: at(minute) })
const write = (t, s, promptId, file = 'src/a.ts', minute = 1) => s.used(promptId, 'Write', { file_path: join(t.repo, file), content: 'x' }, { now: at(minute) })
// Stop の hook の結果：検証の失敗（終了コード 2）、候補の確認（additionalContext）、人への知らせ（systemMessage）、何もなし
const ask = (run) => run.json?.hookSpecificOutput?.additionalContext ?? null
const outcome = (run) => (run.status === 2 ? 'verify' : ask(run) ? 'ask' : run.json?.systemMessage ? 'notice' : run.status === 0 && !run.stdout && !run.stderr ? 'none' : 'error')
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

test('失敗の信号があったターン：改善候補の確認を 1 回だけ頼む（エラーではなく additionalContext で）。同じターンの 2 回目の Stop では頼まない', () => {
  const t = makeEnv()
  const s = session(t)
  s.prompt('p1', 'ユーザー一覧の API を足して', { now: at(0) })
  write(t, s, 'p1')
  signal(s, 'p1')
  const first = s.stop('p1', '足しました', { now: at(2) })
  // 候補の確認は、エラー（終了コード 2）ではなく、hookSpecificOutput.additionalContext で頼む
  assert.equal(first.status, 0)
  assert.equal(first.stderr, '')
  assert.deepEqual(first.json, { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: ask(first) } })
  assert.match(ask(first), /ターン終了時の確認です/)
  assert.match(ask(first), /harness-note keys で既存の原因キーを確かめる/)
  assert.match(ask(first), /harness-note add --session sess-1 --category <カテゴリ> --key <原因キー> --text '<1行>'/)
  // ひな形どおりの add は、ガードを通る。$ やバッククォートを含む文でも、単一引用符の中なら、そのままの文字として渡る
  const template = /^2\. (harness-note add .*)$/m.exec(ask(first))[1]
  const fill = (text) => template.replace('<カテゴリ>', 'dev/mistake').replace('<原因キー>', 'null-user-name').replace('<1行>', text)
  for (const text of ['ルート定義は src/routes/ に置く', '`user.name` が null のとき $HOME の設定を読んで落ちる', 'glob（src/**/*.ts）と {a,b} と ~ は、そのまま書ける']) {
    assert.equal(decisionOf(guardRun(t, 'sess-1', 'Bash', { command: fill(text) }, { now: at(3) })), 'allow', text)
  }
  const recorded = spawnSync('bash', ['-c', fill('`user.name` が null のとき $HOME の設定を読んで落ちる')], { cwd: t.repo, env: { ...t.env, PATH: `${join(ROOT, 'bin')}:${t.env.PATH}`, HARNESS_NOW: at(3) }, encoding: 'utf8' })
  assert.match(recorded.stdout, /記録しました/)
  assert.equal(note(t, ['list', '--json']).json[0].text, '`user.name` が null のとき $HOME の設定を読んで落ちる')
  // 二重引用で書くと、bash が展開するので、ガードが断る。この拒否（harness-note の書式の検査）は、失敗の信号に数えない
  const doubled = guardRun(t, 'sess-1', 'Bash', { command: fill('x').replace("'x'", '"`user.name` が null のとき落ちる"') }, { now: at(3) })
  assert.equal(doubled.status, 2)
  assert.match(doubled.stderr, /ルール：harness-note-call/)
  assert.deepEqual(events(t).filter((e) => e.type === 'guard_denied'), [])
  assert.match(ask(first), /dev\/bug \/ dev\/cause \/ dev\/mistake \/ dev\/other \/ behavior\/preference/)
  assert.match(ask(first), /あと 3 件/)
  assert.match(ask(first), /なければ何も記録せず/)
  // 信号があったターンなので、事象メモも作る
  assert.equal(dataFiles(t, 'episodes').length, 1)

  // Claude が harness-note add を実行して、もう一度止まる。harness-note の実行は「変更あり」に数えない
  s.used('p1', 'Bash', { command: 'harness-note keys' }, { now: at(3) })
  s.used('p1', 'Bash', { command: 'harness-note add --session sess-1 --category dev/mistake --key route-placement --text "x"' }, { now: at(3) })
  const second = s.stop('p1', '記録しました', { now: at(4) }, { stop_hook_active: true })
  assert.deepEqual([second.status, second.stdout, second.stderr], [0, '', ''])
  // 何度止まっても、このターンではもう頼まない（stop_hook_active に頼らず、セッション ID とプロンプト ID の組で止める）
  assert.equal(outcome(s.stop('p1', 'x', { now: at(5) })), 'none')
  assert.equal(events(t).filter((e) => e.type === 'asked').length, 1)

  // 次のターンで信号があれば、また 1 回頼む
  s.prompt('p2', '続けて', { now: at(10) })
  signal(s, 'p2', 11)
  assert.equal(outcome(s.stop('p2', 'x', { now: at(12) })), 'ask')
  assert.equal(outcome(s.stop('p2', 'x', { now: at(13) })), 'none')
})

test('変更があっただけのターン（失敗の信号がない）では、改善候補の確認を頼まない（全リポジトリで動くので、トークンと待ち時間を抑える）', () => {
  const t = makeEnv()
  const s = session(t)
  s.prompt('p1', 'ユーザー一覧の API を足して', { now: at(0) })
  write(t, s, 'p1')
  s.used('p1', 'Bash', { command: 'npm run build' }, { now: at(1) })
  const run = s.stop('p1', '足しました', { now: at(2) })
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', ''])
  assert.deepEqual(dataFiles(t, 'episodes'), [])
  assert.equal(events(t).filter((e) => e.type === 'asked').length, 0)
  // 信号の種類は 4 つ：ツールの失敗、人の訂正、ガードの拒否、検証の失敗。どれかがあれば頼む
  s.prompt('p2', '違う、そこじゃない。戻して', { now: at(10) })
  assert.equal(outcome(s.stop('p2', '戻しました', { now: at(11) })), 'ask')
  s.prompt('p3', 'push して', { now: at(20) })
  assert.equal(guardRun(t, 'sess-1', 'Bash', { command: 'git push --force' }, { now: at(21) }, { prompt_id: 'p3' }).status, 2)
  assert.equal(outcome(s.stop('p3', '止められました', { now: at(22) })), 'ask')
})

test('harness-note だけ・読むだけのコマンドだけのターンでは、確認を頼まず、検証も走らせない', () => {
  const t = makeEnv()
  writeFiles(t.repo, { 'harness/config.json': verifyConfig(t) })
  const s = session(t)
  s.prompt('p1', '改善候補を見せて', { now: at(0) })
  s.used('p1', 'Bash', { command: 'harness-note list' }, { now: at(1) })
  s.used('p1', 'Bash', { command: 'git status && ls src' }, { now: at(1) })
  const run = s.stop('p1', '一覧です', { now: at(2) })
  assert.equal(outcome(run), 'none')
  assert.equal(runs(t), 0)
})

test('信号があったターン：事象メモを機械的に作り、確認の依頼に参照を添える', () => {
  const t = makeEnv()
  const s = session(t)
  s.prompt('p1', 'テストを直して', { now: at(0) })
  s.failed('p1', 'Bash', { command: 'npm test' }, "Exit code 1\nError: Cannot find module 'express'", { now: at(1) })
  const run = s.stop('p1', '依存が足りないので、入れてから再実行します', { now: at(2) })
  assert.equal(outcome(run), 'ask')
  const files = dataFiles(t, 'episodes')
  assert.equal(files.length, 1)
  const id = files[0].split('/')[1].replace('.md', '')
  assert.match(id, /^ep-20261116-090000-sess-1-[0-9a-f]{6}$/)
  assert.match(ask(run), new RegExp(`--text '<1行>' --episode ${id}`))

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
  assert.equal(outcome(run), 'ask')
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
  writeFiles(t.repo, { 'harness/config.json': verifyConfig(t) })
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
  assert.equal(failed.stdout, '')
  assert.equal(events(t).filter((e) => e.type === 'asked').length, 0)
  // 検証の失敗は自分で記録し、事象メモにも入る
  const logged = events(t).find((e) => e.type === 'verify_failed')
  assert.deepEqual([logged.name, logged.streak, logged.incidents, logged.prompt_id], ['typecheck', 1, ['INC-2026-0012'], 'p1'])
  assert.match(readData(t, 'episodes', dataFiles(t, 'episodes')[0]), /- 検証の失敗：typecheck（連続 1 回目、関連する失敗票 INC-2026-0012）/)

  // Claude が直して、検証が通る → その Stop で候補の確認を頼む
  writeFileSync(join(t.repo, 'ok.txt'), '')
  write(t, s, 'p1', 'src/a.ts', 3)
  const passed = s.stop('p1', '直りました', { now: at(4) })
  assert.equal(outcome(passed), 'ask')
  assert.match(ask(passed), /ターン終了時の確認です/)
  assert.equal(runs(t), 2)
  // 候補を記録して止まる。検証が通ったあとに変更はないので、検証は繰り返さない
  s.used('p1', 'Bash', { command: 'harness-note add --session sess-1 --category dev/mistake --key type-error --text "x"' }, { now: at(5) })
  assert.equal(outcome(s.stop('p1', '記録しました', { now: at(6) })), 'none')
  assert.equal(runs(t), 2)

  // 変更のないターン（ツールの失敗だけ）では、検証を走らせない
  s.prompt('p2', 'ログを見て', { now: at(10) })
  s.failed('p2', 'Read', { file_path: join(t.repo, 'nope.log') }, 'File does not exist', { now: at(11) })
  s.stop('p2', 'ありませんでした', { now: at(12) })
  assert.equal(runs(t), 2)
})

test('検証の失敗が連続 3 回で打ち切り、人に知らせる（Claude には続けさせない）', () => {
  const t = makeEnv()
  writeFiles(t.repo, { 'harness/config.json': verifyConfig(t) })
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
  assert.match(ask(s.stop('p2', 'x', { now: at(14) })), /ターン終了時の確認です/)
  rmSync(join(t.repo, 'ok.txt'))
  s.prompt('p3', 'さらに', { now: at(20) })
  write(t, s, 'p3', 'src/a.ts', 21)
  assert.match(s.stop('p3', 'x', { now: at(22) }).stderr, /連続 1 回目/)
})

// プロセスが残っているか（シグナル 0 は、届け先があるかだけを確かめる）。
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitFor = async (check, ms = 5000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}
// 子（さらにその先）のプロセスを残して待つ検証コマンド。子の PID をファイルに書く。
const slowVerify = (t, timeoutSec) => ({ verify: [{ name: 'slow', run: `(sleep 300 & echo $! > "${join(t.base, 'child.pid')}"; wait)`, timeout_sec: timeoutSec }] })
const childPid = (t) => Number(readFileSync(join(t.base, 'child.pid'), 'utf8').trim())

test('検証のタイムアウト：シェルだけでなく、その先で動いている子孫のプロセスも止める', { skip: process.platform === 'win32' }, async () => {
  const t = makeEnv()
  writeFiles(t.repo, { 'harness/config.json': slowVerify(t, 1) })
  const s = session(t)
  s.prompt('p1', 'テストを直して', { now: at(0) })
  write(t, s, 'p1')
  const run = s.stop('p1', '直しました', { now: at(2) })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /検証「slow」.*がタイムアウトしました/)
  const pid = childPid(t)
  assert.equal(await waitFor(() => !alive(pid)), true, `子のプロセス ${pid} が残っている`)
})

test('hook 自身が止められたときも、検証コマンドを残さない', { skip: process.platform === 'win32' }, async () => {
  const t = makeEnv()
  writeFiles(t.repo, { 'harness/config.json': slowVerify(t, 240) })
  const s = session(t)
  s.prompt('p1', 'テストを直して', { now: at(0) })
  write(t, s, 'p1')
  const hook = spawn(process.execPath, [join(ROOT, 'scripts/on-stop.mjs')], { cwd: t.repo, env: { ...t.env, HARNESS_NOW: at(2) }, stdio: ['pipe', 'ignore', 'ignore'] })
  hook.stdin.end(JSON.stringify({ session_id: s.id, cwd: t.repo, hook_event_name: 'Stop', prompt_id: 'p1', stop_hook_active: false, last_assistant_message: '直しました' }))
  const exited = new Promise((r) => hook.on('exit', r))
  assert.equal(await waitFor(() => existsSync(join(t.base, 'child.pid')) && readFileSync(join(t.base, 'child.pid'), 'utf8').trim() !== ''), true, '検証コマンドが始まらない')
  const pid = childPid(t)
  assert.equal(alive(pid), true)
  hook.kill('SIGTERM')
  await exited
  assert.equal(await waitFor(() => !alive(pid)), true, `子のプロセス ${pid} が残っている`)
})

test('1 ターンのあいだに続けさせる回数には、万一の上限がある', () => {
  const t = makeEnv()
  writeFiles(t.repo, { 'harness/config.json': verifyConfig(t) })
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
  assert.match(ask(stopAfterChange()), /ターン終了時の確認/) // 通って、確認を頼む（3）
  rmSync(ok)
  assert.equal(stopAfterChange().status, 2) // 4
  assert.equal(stopAfterChange().status, 2) // 5
  writeFileSync(ok, '')
  assert.equal(outcome(stopAfterChange()), 'none') // 通る。確認は済んでいる
  rmSync(ok)
  assert.equal(stopAfterChange().status, 2) // 6
  const last = stopAfterChange()
  assert.equal(last.status, 0)
  assert.match(last.json.systemMessage, /検証「typecheck」.*このターンで続行が 6 回に達したので、打ち切りました。コードは検証が通っていない状態です/)
})

test('そのセッションの候補が上限（3 件）に達していれば、確認を頼まない', () => {
  const t = makeEnv()
  const s = session(t)
  for (const [i, key] of ['key-one', 'key-two'].entries()) {
    note(t, ['add', '--session', 'sess-1', '--category', 'dev/mistake', '--key', key, '--text', 'x'], { now: at(i) })
  }
  s.prompt('p1', 'a', { now: at(10) })
  signal(s, 'p1', 11)
  assert.match(ask(s.stop('p1', 'x', { now: at(12) })), /あと 1 件/)
  note(t, ['add', '--session', 'sess-1', '--category', 'dev/mistake', '--key', 'key-three', '--text', 'x'], { now: at(13) })
  s.prompt('p2', 'b', { now: at(20) })
  signal(s, 'p2', 21)
  const run = s.stop('p2', 'x', { now: at(22) })
  assert.equal(outcome(run), 'none')
  // 上限は、そのセッションが直近 24 時間に記録した件数で数える。日をまたいで使うセッションは、また頼まれる
  // 信号があれば、事象メモは上限に関係なく作る
  assert.equal(dataFiles(t, 'episodes').length, 2)
  s.prompt('p9', 'd', { now: at(0, 2) })
  signal(s, 'p9', 60 * 24 * 2 + 1)
  assert.match(ask(s.stop('p9', 'x', { now: at(2, 2) })), /あと 3 件/)
})

test('自動改善のセッションでは、検証も事象メモも候補の確認も動かさない', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7 } } })
  writeFiles(t.repo, { 'harness/config.json': verifyConfig(t) })
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
  assert.equal(outcome(human.stop('h1', 'x', { now: at(6) })), 'verify')
  assert.equal(runs(t), 1)
})

test('git リポジトリでない場所と HARNESS_DISABLE=1 では、何もしない', () => {
  const none = makeEnv({ git: false })
  const n = session(none)
  n.used('p1', 'Write', { file_path: 'a' })
  const off = n.stop('p1', 'x')
  assert.deepEqual([off.status, off.stdout, off.stderr], [0, '', ''])
  assert.equal(existsSync(none.data), false)

  const t = makeEnv()
  const s = session(t)
  s.prompt('p1', 'a', { now: at(0) })
  signal(s, 'p1')
  const disabled = s.stop('p1', 'x', { now: at(2), env: { HARNESS_DISABLE: '1' } })
  assert.deepEqual([disabled.status, disabled.stdout, disabled.stderr], [0, '', ''])
  // 止めていなければ頼む（同じ状態から）
  assert.equal(outcome(s.stop('p1', 'x', { now: at(3) })), 'ask')
})

test('prompt_id が渡らない版でも、ターンの始まりの時刻で区切って 1 回だけ頼む', () => {
  const t = makeEnv()
  const s = session(t)
  s.prompt(undefined, '最初の依頼', { now: at(0) })
  s.failed(undefined, 'Bash', { command: 'npm test' }, 'Exit code 1', { now: at(1) })
  assert.equal(outcome(s.stop(undefined, 'x', { now: at(2) })), 'ask')
  assert.equal(outcome(s.stop(undefined, 'x', { now: at(3) })), 'none')
  // 次のターンに信号がなければ、前のターンの信号は数えない
  s.prompt(undefined, '質問だけ', { now: at(10) })
  assert.equal(outcome(s.stop(undefined, 'x', { now: at(11) })), 'none')
  s.prompt(undefined, 'もう一度', { now: at(20) })
  s.failed(undefined, 'Bash', { command: 'npm test' }, 'Exit code 1', { now: at(21) })
  assert.equal(outcome(s.stop(undefined, 'x', { now: at(22) })), 'ask')
  assert.ok(repoId(t))
})

test('確認の依頼文に、報告のしかたの指示が入っている：記録したら、ユーザーの使っている言語で 1 行だけ報告する（2.0.1）', () => {
  const t = makeEnv()
  const s = session(t)
  s.prompt('p1', 'Add an endpoint that lists users', { now: at(0) })
  signal(s, 'p1')
  const message = ask(s.stop('p1', 'Done.', { now: at(2) }))
  // 手順 4：依頼文そのものは日本語だが、報告は、会話でユーザーが使っている言語に合わせる。例も添える
  assert.match(message, /^4\. 記録したら、ユーザーへの報告は、この会話でユーザーが使っている言語で 1 行だけ書く（例：「改善候補を 1 件記録しました：<原因キー>」）$/m)
  // 手順は 1〜4 の順に並び、4 が最後
  const steps = [...message.matchAll(/^(\d)\. /gm)].map((m) => Number(m[1]))
  assert.deepEqual(steps, [1, 2, 3, 4])
  assert.ok(message.trimEnd().split('\n').at(-1).startsWith('4. '))
  // 記録するものがないときは、何も書かずに終わる、という指示は変えない
  assert.match(message, /なければ何も記録せず、説明も足さずに、そのまま終了してください/)
  assert.match(message, /^3\. このセッションで記録できるのは、あと 3 件。記録したら、ほかの作業はせずに終了する$/m)
})
