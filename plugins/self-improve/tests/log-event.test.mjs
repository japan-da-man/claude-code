import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { correctionWords } from '../scripts/log-event.mjs'
import { at, events, makeEnv, note, repoId, session } from './helpers.mjs'

test('UserPromptSubmit: 依頼文は 1 ターン分だけ一時的に持ち、生ログには本文を残さない', () => {
  const t = makeEnv()
  const s = session(t)
  const run = s.prompt('p1', 'ユーザー一覧の API を足して。トークンは sk-secret', { now: at(0) })
  assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', ''])
  const turn = JSON.parse(readFileSync(join(t.data, 'state', repoId(t), 'sessions/sess-1/turn.json'), 'utf8'))
  assert.deepEqual(turn, { prompt_id: 'p1', prompt: 'ユーザー一覧の API を足して。トークンは sk-secret', at: at(0), correction: [] })
  const logged = events(t)
  assert.deepEqual(logged.map((e) => [e.type, e.session_id, e.prompt_id]), [['prompt', 'sess-1', 'p1']])
  assert.doesNotMatch(JSON.stringify(logged), /sk-secret/)
  // 次のターンで上書きされる
  s.prompt('p2', '次の依頼', { now: at(5) })
  assert.equal(JSON.parse(readFileSync(join(t.data, 'state', repoId(t), 'sessions/sess-1/turn.json'), 'utf8')).prompt, '次の依頼')
})

test('訂正語：直前のターンがあるときだけ検出する', () => {
  const t = makeEnv({ config: { correction_words: ['ちゃうねん'] } })
  const s = session(t)
  // セッションの最初の依頼は、訂正語を含んでいても訂正ではない
  s.prompt('p1', '違うやり方で実装して', { now: at(0) })
  assert.deepEqual(events(t).map((e) => e.type), ['prompt'])
  s.stop('p1', '実装しました', { now: at(1) })
  s.prompt('p2', '違う、そこじゃない。戻して', { now: at(2) })
  const correction = events(t).find((e) => e.type === 'human_correction')
  assert.deepEqual([correction.prompt_id, correction.words], ['p2', ['違う', '戻して']])
  s.stop('p2', '戻しました', { now: at(3) })
  s.prompt('p3', 'ありがとう。次はテストを足して', { now: at(4) })
  assert.equal(events(t).filter((e) => e.type === 'human_correction').length, 1)

  assert.deepEqual(correctionWords('No, that is wrong'), ['no,'])
  assert.deepEqual(correctionWords('please revert it'), ['revert'])
  assert.deepEqual(correctionWords('ちゃうねん', ['ちゃうねん']), ['ちゃうねん'])
  assert.deepEqual(correctionWords('/self-improve:retro 違う'), [])
  assert.deepEqual(correctionWords('know nothing about normal notes'), [])
  // 質問の文は、訂正に数えない（「違う」を含んでいても）
  for (const question of ['A と B は何が違う？', 'この 2 つはどう違うんですか?', '違いは何ですか', 'What is wrong with this approach?', 'この実装に間違いがないか見て']) {
    assert.deepEqual(correctionWords(question), [], question)
  }
  // 質問のあとに訂正が続けば、訂正として数える
  assert.deepEqual(correctionWords('何が違う？ いや、そうじゃなくて戻して'), ['そうじゃな', '戻して'])
})

test('PostToolUseFailure: tool_name、error の 1 行目、is_interrupt を残す。harness-note の失敗は数えない', () => {
  const t = makeEnv()
  const s = session(t)
  s.failed('p1', 'Bash', { command: 'npm test' }, "Exit code 1\nError: Cannot find module 'express'\n    at stack", { now: at(0) })
  s.failed('p1', 'Edit', { file_path: join(t.repo, 'src/a.ts') }, 'String to replace not found', { now: at(1) }, { is_interrupt: true })
  s.failed('p1', 'Bash', { command: 'harness-note add --category nope --key x --text y' }, 'Exit code 1', { now: at(2) })
  const logged = events(t)
  assert.deepEqual(logged.map((e) => [e.type, e.tool, e.error, e.is_interrupt, e.target]), [
    ['tool_failure', 'Bash', 'Exit code 1', false, 'npm test'],
    ['tool_failure', 'Edit', 'String to replace not found', true, 'src/a.ts'],
  ])
})

test('PostToolUse: Write・Edit・Bash で「変更あり」の印を付ける。harness-note と読むだけのコマンドは数えない', () => {
  const t = makeEnv()
  const s = session(t)
  s.used('p1', 'Write', { file_path: join(t.repo, 'src/a.ts'), content: 'x' }, { now: at(0) })
  s.used('p1', 'Edit', { file_path: join(t.repo, 'src/b.ts') }, { now: at(1) })
  s.used('p1', 'Bash', { command: 'npm run build' }, { now: at(2) })
  s.used('p1', 'Bash', { command: 'harness-note add --category dev/bug --key some-bug --text "x"' }, { now: at(3) })
  s.used('p1', 'Bash', { command: 'harness-note keys && git status' }, { now: at(4) })
  s.used('p1', 'Bash', { command: 'ls -la && cat package.json' }, { now: at(5) })
  s.used('p1', 'Read', { file_path: join(t.repo, 'src/a.ts') }, { now: at(6) })
  assert.deepEqual(events(t).map((e) => [e.type, e.tool, e.target]), [
    ['change', 'Write', 'src/a.ts'],
    ['change', 'Edit', 'src/b.ts'],
    ['change', 'Bash', null],
  ])
})

test('自動改善のセッションの分は記録しない。別のセッションの記録は止まらない', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7 } } })
  note(t, ['lock', '--session', 'auto-1'], { now: at(0) })
  const auto = session(t, 'auto-1')
  auto.prompt('p1', 'auto-improve を続けて', { now: at(1) })
  auto.failed('p1', 'Bash', { command: 'npm test' }, 'Exit code 1', { now: at(2) })
  auto.used('p1', 'Bash', { command: 'npm run build' }, { now: at(3) })
  assert.deepEqual(events(t), [])
  assert.equal(existsSync(join(t.data, 'state', repoId(t), 'sessions/auto-1/turn.json')), false)
  session(t, 'human-1').used('p9', 'Write', { file_path: join(t.repo, 'a.ts') }, { now: at(4) })
  assert.deepEqual(events(t).map((e) => e.session_id), ['human-1'])
})

test('harness/config.json がないリポジトリと HARNESS_DISABLE=1 では、何も記録しない', () => {
  const none = makeEnv({ git: false })
  const s = session(none)
  for (const run of [s.prompt('p1', '違う'), s.used('p1', 'Write', { file_path: 'a' }), s.failed('p1', 'Bash', { command: 'x' }, 'boom')]) {
    assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', ''])
  }
  assert.equal(existsSync(none.data), false)

  const t = makeEnv()
  const off = { env: { HARNESS_DISABLE: '1' } }
  const d = session(t)
  d.prompt('p1', 'x', off)
  d.used('p1', 'Write', { file_path: 'a' }, off)
  d.failed('p1', 'Bash', { command: 'x' }, 'boom', off)
  assert.equal(existsSync(t.data), false)
})
