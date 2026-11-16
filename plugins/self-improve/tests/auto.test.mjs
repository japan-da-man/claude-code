import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { at, dataFiles, draft, finishAuto, knownSession, makeEnv, note, readData, repoId, seedCandidates, startAuto, writeFiles } from './helpers.mjs'

const AUTO = { auto: { interval_days: 7 } }
const trialAdd = (t, key, opts = {}, text = `${key} の決まりを守る`) =>
  note(t, ['trial', 'add', '--session', opts.session ?? 'auto-1', '--key', key, '--text', text], { now: opts.now ?? at(62) })

test('lock: interval_days が 0 なら停止。何もせず終了するよう返し、ロックもしない', () => {
  const t = makeEnv()
  seedCandidates(t, 'route-placement', ['s1', 's2'])
  const run = note(t, ['lock', '--session', 'auto-1'], { now: at(60) })
  assert.equal(run.status, 0)
  assert.match(run.stdout, /自動改善は止めてあります（auto\.interval_days が 0）。何もせず終了してください/)
  assert.equal(note(t, ['status', '--json', '--session', 'auto-1']).json.lock, null)
  assert.equal(note(t, ['lock', '--session', 'auto-1', '--json'], { now: at(60) }).json.reason, 'disabled')
})

test('lock: 前回の実行から間隔の半分がたっていなければ何もしない。追いかけの実行と手動の実行が重なっても二重に動かない', () => {
  const t = makeEnv({ config: AUTO })
  seedCandidates(t, 'route-placement', ['s1', 's2'])
  assert.match(note(t, ['lock', '--session', 'auto-1'], { now: at(60) }).stdout, /自動改善を開始しました/)
  finishAuto(t, { now: at(70) })

  // 直後の追いかけの実行や、3 日後の手動実行：間隔（7 日）の半分がたっていない
  for (const [session, now] of [['auto-2', at(75)], ['manual-1', at(0, 3)]]) {
    const early = note(t, ['lock', '--session', session], { now })
    assert.match(early.stdout, /前回の実行（2026-11-16）から間隔がたっていません。何もせず終了してください/)
    assert.equal(note(t, ['status', '--json', '--session', session], { now }).json.lock, null)
  }
  // 間隔がたっていないセッションでは、書き込みも「自動」にならない（ロックがないので skill add は見送り）
  assert.match(note(t, ['skill', 'add', '--session', 'manual-1', '--key', 'route-placement', '--name', 'x', '--description', 'demo-app', '--body', 'b'], { now: at(1, 3) }).stdout, /見送り/)
  // 半分を過ぎれば動く
  assert.match(note(t, ['lock', '--session', 'auto-3'], { now: at(0, 4) }).stdout, /自動改善を開始しました/)
})

test('追いかけの実行のあとでも、翌週の定時の実行は飛ばない（毎週月曜 9 時・間隔 7 日の想定）', () => {
  const t = makeEnv({ config: AUTO })
  seedCandidates(t, 'route-placement', ['s1', 's2'], { now: at(0) })
  const monday = (week) => at(0, 7 * week) // 2026-11-16 は月曜。9 時（UTC）
  const interval = (now) => note(t, ['status', '--json', '--session', 'x'], { now }).json.interval
  // 1 週目：月曜 9 時を逃し、火曜 20 時に追いかけて実行された
  const tuesdayNight = at(35 * 60, 0)
  assert.match(note(t, ['lock', '--session', 'week-1'], { now: tuesdayNight }).stdout, /自動改善を開始しました/)
  finishAuto(t, { session: 'week-1', now: at(35 * 60 + 5, 0) })
  // 2 週目：月曜 9 時の定時の実行は、飛ばずに動く（前回から 5 日半。間隔の半分は過ぎている）
  assert.match(note(t, ['lock', '--session', 'week-2'], { now: monday(1) }).stdout, /自動改善を開始しました/)
  finishAuto(t, { session: 'week-2', now: at(5, 7) })
  // その週の水曜：「実行されていません」にはならない
  assert.deepEqual([interval(at(0, 9)).due, interval(at(0, 9)).overdue], [false, false])
  // 3 週目も定時に動く
  assert.match(note(t, ['lock', '--session', 'week-3'], { now: monday(2) }).stdout, /自動改善を開始しました/)
  finishAuto(t, { session: 'week-3', now: at(5, 14) })
  // 実行されないまま間隔（7 日）を過ぎたら、overdue
  assert.equal(interval(at(0, 21)).overdue, false)
  assert.equal(interval(at(10, 21)).overdue, true)
})

test('lock: セッション単位。別のセッションは実行中なら入れず、2 時間で失効する', () => {
  const t = makeEnv({ config: AUTO })
  assert.match(note(t, ['lock', '--session', 'auto-1'], { now: at(0) }).stdout, /開始しました/)
  assert.equal(note(t, ['lock', '--session', 'auto-1', '--json'], { now: at(1) }).json.resumed, true)
  assert.equal(note(t, ['lock', '--session', 'auto-2', '--json'], { now: at(2) }).json.reason, 'locked')
  assert.match(note(t, ['unlock', '--session', 'auto-2'], { now: at(3) }).stdout, /別のセッションのロック/)
  // ロックの ID は、全文では出さない（ほかのセッションが名乗れないように）
  const shown = note(t, ['status', '--json', '--session', 'auto-2'], { now: at(4) })
  assert.deepEqual([shown.json.lock.session, shown.json.lock.mine], ['auto-1', false])
  const t3 = makeEnv({ config: AUTO })
  note(t3, ['lock', '--session', 'a-very-long-session-identifier-0001'], { now: at(0) })
  assert.doesNotMatch(note(t3, ['status', '--json', '--session', 'other'], { now: at(1) }).stdout, /a-very-long-session-identifier-0001/)
  assert.doesNotMatch(note(t3, ['status', '--session', 'other'], { now: at(1) }).stdout, /a-very-long-session-identifier-0001/)
  assert.equal(note(t, ['status', '--json', '--session', 'auto-1'], { now: at(119) }).json.lock.mine, true)
  assert.equal(note(t, ['status', '--json', '--session', 'auto-1'], { now: at(121) }).json.lock, null)
  // セッション ID が分からないまま lock はしない（人のセッションを巻き込まないため）
  const t2 = makeEnv({ config: AUTO })
  const blind = note(t2, ['lock'])
  assert.equal(blind.status, 1)
  assert.match(blind.stderr, /--session/)
  assert.match(note(t2, ['lock'], { env: { HARNESS_SESSION_ID: 'from-env' } }).stdout, /開始しました/)
})

test('unlock: 外せるのは、ロックしたセッション自身が、実行の記録（report write）を書いたあとだけ', () => {
  const t = makeEnv({ config: AUTO })
  startAuto(t, ['route-placement'])
  const early = note(t, ['unlock', '--session', 'auto-1'], { now: at(61) })
  assert.equal(early.status, 0)
  assert.match(early.stdout, /見送り：先に harness-note report write で実行の記録を書いてください/)
  assert.equal(note(t, ['status', '--json', '--session', 'auto-1'], { now: at(62) }).json.lock.mine, true)
  // セッション ID を推定で決めた unlock は受け付けない（別のセッションが、自動改善のロックを外してしまうのを防ぐ）
  const guessed = note(t, ['unlock'], { now: at(62) })
  assert.equal(guessed.status, 1)
  assert.match(guessed.stderr, /セッション ID が分かりません/)
  assert.match(note(t, ['unlock', '--session', 'someone-else'], { now: at(62) }).stdout, /別のセッションのロックなので、解除しません/)
  assert.equal(note(t, ['status', '--json', '--session', 'auto-1'], { now: at(62) }).json.lock.mine, true)

  note(t, ['report', 'write', '--session', 'auto-1', '--body', '何もしなかった'], { now: at(63) })
  const done = note(t, ['unlock', '--session', 'auto-1'], { now: at(64) })
  assert.match(done.stdout, /自動改善のロックを解除しました。このセッションでは、このあとも書き込みに確認が挟まり、harness-note での試用の追加や確認の記録は見送りになります/)
  assert.equal(note(t, ['status', '--json', '--session', 'auto-1'], { now: at(65) }).json.lock, null)
  assert.equal(note(t, ['status', '--json', '--session', 'auto-1'], { now: at(65) }).json.auto_session, true)
})

test('自動改善の実行中は、セッションを確かめられない書き込みを受け付けない（歯止めのすり抜けを防ぐ）', () => {
  const t = makeEnv({ config: AUTO })
  startAuto(t, ['route-placement'])
  draft(t, 'route-placement')
  // --session がなく、環境変数も渡らない → どのセッションか分からない
  const blind = note(t, ['trial', 'add', '--key', 'route-placement', '--text', 'ルートは src/routes/ に置く'], { now: at(62) })
  assert.equal(blind.status, 1)
  assert.match(blind.stderr, /自動改善が実行中です.*--session/)
  assert.equal(note(t, ['pending', 'add', '--key', 'other-key', '--root-cause', 'knowledge', '--asked', 'a', '--expected', 'b', '--actual', 'c'], { now: at(62) }).status, 1)
  assert.match(note(t, ['add', '--category', 'dev/mistake', '--key', 'some-key', '--text', 'x'], { now: at(62) }).stdout, /記録しません/)
  assert.deepEqual(dataFiles(t, 'trial'), [])
  // 環境変数でセッションが分かれば、そのセッションとして扱う
  assert.match(note(t, ['trial', 'add', '--key', 'route-placement', '--text', 'ルートは src/routes/ に置く'], { now: at(63), env: { HARNESS_SESSION_ID: 'auto-1' } }).stdout, /追加しました/)
  assert.equal(note(t, ['trial', 'list', '--json']).json[0].by, 'auto')
  // ロックが外れたあと：--session なしだと、直近のセッション（自動改善のセッション）と見なされるので、受け付けない
  finishAuto(t, { now: at(64) })
  assert.match(note(t, ['trial', 'add', '--key', 'human-rule', '--text', '人が足したルール'], { now: at(65) }).stdout, /見送り：このセッションは、自動改善（auto-improve）を呼び出したセッション/)
  // 別のセッションからなら、人の書き込みとして受け付ける
  assert.match(note(t, ['trial', 'add', '--session', 'human-1', '--key', 'human-rule', '--text', '人が足したルール'], { now: at(65) }).stdout, /追加しました/)
})

test('--session は自己申告。hook が引き渡した ID と食い違えば受け付けず、自動改善の実行中は、ロックしたセッション以外からの人だけの操作を見送る', () => {
  const t = makeEnv({ config: AUTO })
  startAuto(t, ['route-placement'])
  draft(t, 'route-placement')
  // ロック中のセッション（hook が HARNESS_SESSION_ID=auto-1 を引き渡している）が、別の ID を名乗る
  const handed = { HARNESS_SESSION_ID: 'auto-1' }
  for (const args of [
    ['trial', 'add', '--session', 'not-auto', '--key', 'any-key', '--text', '好きな 1 行'],
    ['trial', 'add', '--session=not-auto', '--key', 'any-key', '--text', '好きな 1 行'],
    ['mark', '--key', 'route-placement', '--status', 'rejected', '--session', 'zzz'],
    ['rekey', 'route-placement', 'other-key', '--session', 'zzz'],
    ['pending', 'remove', 'route-placement', '--session', 'zzz'],
    ['add', '--session', 'zzz', '--category', 'dev/mistake', '--key', 'some-key', '--text', 'x'],
    ['unlock', '--session', 'zzz'],
    ['trial', 'add', '--session', 'auto-1', '--session', 'zzz', '--key', 'any-key', '--text', 'x'],
  ]) {
    const run = note(t, args, { now: at(62), env: handed, known: false })
    assert.equal(run.status, 1, args.join(' '))
    assert.match(run.stderr, /ほかのセッションを名乗ることはできません|値が食い違っています/)
  }
  assert.deepEqual(dataFiles(t, 'trial'), [])
  assert.equal(note(t, ['list', '--key', 'route-placement', '--status', 'consumed', '--json']).json.length, 2)

  // 環境変数が渡らない場合（引き渡しが効かない環境）：名乗りは確かめられないので、自動改善の実行中は、
  // ロックしたセッション以外からの人だけの操作を、すべて見送る
  for (const args of [
    ['trial', 'add', '--session', 'not-auto', '--key', 'any-key', '--text', '好きな 1 行'],
    ['trial', 'edit', '--session', 'not-auto', '--key', 'route-placement', '--text', '書き換え'],
    ['trial', 'remove', '--session', 'not-auto', '--key', 'route-placement'],
    ['mark', '--key', 'route-placement', '--status', 'rejected', '--session', 'zzz'],
    ['rekey', 'route-placement', 'other-key', '--session', 'zzz'],
    ['pending', 'remove', 'route-placement', '--session', 'zzz'],
    ['report', 'close', '--session', 'zzz'],
    ['review', 'done', 'a-any', '--decision', 'keep', '--session', 'zzz'],
  ]) {
    const run = note(t, args, { now: at(63) })
    assert.equal(run.status, 0, args.join(' '))
    assert.match(run.stdout, /^見送り：自動改善が実行中です/, args.join(' '))
  }
  assert.deepEqual(dataFiles(t, 'trial'), [])
  assert.equal(note(t, ['pending', 'show', 'route-placement']).status, 0)
  assert.equal(note(t, ['list', '--key', 'route-placement', '--status', 'consumed', '--json']).json.length, 2)
  // 正しい ID なら、対象の外には書けない
  assert.match(note(t, ['trial', 'add', '--session', 'auto-1', '--key', 'other-key', '--text', 'x'], { now: at(65) }).stdout, /今回の対象ではありません/)
})

test('重大-A の再現：ロックを外したあと・lock が始まらなかったあとの自動改善のセッションは、「人」として harness-note を使えない', () => {
  const t = makeEnv({ config: AUTO })
  startAuto(t, ['route-placement'])
  draft(t, 'route-placement')
  assert.match(trialAdd(t, 'route-placement').stdout, /追加しました/)
  finishAuto(t, { now: at(63) })
  const autoState = () => JSON.parse(readFileSync(join(t.data, 'state', repoId(t), 'auto.json'), 'utf8'))
  const changeId = autoState().changes[0].id

  // SessionStart の引き渡し（HARNESS_SESSION_ID）が働いていても、いなくても同じ
  for (const env of [{ HARNESS_SESSION_ID: 'auto-1' }, {}]) {
    for (const args of [
      ['trial', 'add', '--session', 'auto-1', '--key', 'free-key', '--text', '対象外の原因に入れた 1 行'],
      ['trial', 'edit', '--session', 'auto-1', '--key', 'route-placement', '--text', '書き換えた 1 行'],
      ['trial', 'remove', '--session', 'auto-1', '--key', 'route-placement'],
      ['skill', 'remove', '--session', 'auto-1', '--name', 'anything'],
      ['mark', '--session', 'auto-1', '--key', 'route-placement', '--status', 'rejected'],
      ['rekey', 'route-placement', 'other-key', '--session', 'auto-1'],
      ['pending', 'remove', 'route-placement', '--session', 'auto-1'],
      ['review', 'done', changeId, '--decision', 'keep', '--session', 'auto-1'],
      ['report', 'close', '--session', 'auto-1'],
    ]) {
      const run = note(t, args, { now: at(70), env })
      assert.equal(run.status, 0, args.join(' '))
      assert.match(run.stdout, /^見送り：このセッションは、自動改善（auto-improve）を呼び出したセッションです/, args.join(' '))
    }
  }
  // 何も変わっていない：試用は 1 件のまま、未確認のまま、下書きも報告も残っている
  assert.deepEqual(note(t, ['trial', 'list', '--json']).json.map((r) => [r.cause_key, r.text]), [['route-placement', 'route-placement の決まりを守る']])
  const review = note(t, ['review', '--session', 'auto-1'], { now: at(71) }).json
  assert.deepEqual(review.unreviewed.map((c) => c.id), [changeId])
  assert.equal(note(t, ['pending', 'show', 'route-placement']).status, 0)
  assert.equal(note(t, ['report', 'list', '--json']).json[0].closed_at, null)
  // 読むだけの操作は、これまでどおり使える
  for (const args of [['keys'], ['list'], ['trial', 'list'], ['report', 'show'], ['status'], ['targets']]) {
    assert.equal(note(t, [...args, '--session', 'auto-1'], { now: at(71) }).status, 0, args.join(' '))
  }

  // lock が始まらなかったセッション（間隔がたっていない）も同じ
  assert.match(note(t, ['lock', '--session', 'auto-2'], { now: at(80) }).stdout, /間隔がたっていません/)
  assert.match(note(t, ['trial', 'add', '--session', 'auto-2', '--key', 'free-key', '--text', 'x'], { now: at(81) }).stdout, /^見送り：このセッションは、自動改善/)
  assert.match(note(t, ['review', 'done', changeId, '--decision', 'keep', '--session', 'auto-2'], { now: at(81) }).stdout, /^見送り/)

  // 人のセッション（lock を試みていないセッション）なら、確認できる
  assert.match(note(t, ['review', 'done', changeId, '--decision', 'keep', '--session', 'human-1'], { now: at(90) }).stdout, /確認済みにしました/)

  // 「lock を試みたセッション」の記録は 14 日で切れる。期限は読み出すときにも確かめ、次の書き換えで消す（次の lock を待たない）
  assert.equal(note(t, ['status', '--json', '--session', 'auto-1'], { now: at(0, 13) }).json.auto_session, true)
  assert.equal(note(t, ['status', '--json', '--session', 'auto-1'], { now: at(0, 15) }).json.auto_session, false)
  assert.deepEqual(Object.keys(autoState().auto_sessions).sort(), ['auto-1', 'auto-2'])
  assert.match(note(t, ['trial', 'add', '--session', 'human-1', '--key', 'later-key', '--text', '15 日後に人が足した 1 行'], { now: at(1, 15) }).stdout, /追加しました/)
  assert.deepEqual(autoState().auto_sessions, {})
})

test('試用ルールは、誰が入れたものでも、人が review で確認するまで未確認として数える（名乗りの判定に頼らない）', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7, max_unreviewed: 2 } } })
  const added = note(t, ['trial', 'add', '--session', 'human-1', '--key', 'route-placement', '--text', 'ルートは src/routes/ に置く'], { now: at(0) })
  assert.match(added.stdout, /試用ルールを追加しました/)
  assert.match(added.stdout, /人が \/self-improve:review で確認するまで、未確認として数えます（変更 ID：a-route-placement-/)
  const first = note(t, ['review', '--session', 'human-1'], { now: at(1) }).json.unreviewed
  assert.deepEqual(first.map((c) => [c.kind, c.cause_key, c.manual]), [['trial_add', 'route-placement', true]])
  assert.match(first[0].note, /自動改善の実行の外で（harness-note trial add \/ edit で）入った試用ルールです/)
  // 同じ原因を編集しても、二重には数えない（review の「直す」と同じ流れ）
  note(t, ['trial', 'edit', '--session', 'human-1', '--key', 'route-placement', '--text', 'ルート定義は src/routes/ に置く'], { now: at(2) })
  assert.equal(note(t, ['status', '--json']).json.gates.unreviewed, 1)
  // 未確認の上限にも数える（確認していない試用がたまっているあいだ、自動改善は追加しない）
  note(t, ['trial', 'add', '--session', 'human-1', '--key', 'second-key', '--text', '2 つ目の決まり'], { now: at(3) })
  seedCandidates(t, 'third-key', ['s1', 's2'], { now: at(4) })
  assert.match(note(t, ['lock', '--session', 'auto-1'], { now: at(60) }).stdout, /未確認の自動変更：2 件（上限 2 件） → 上限に達しています/)
  finishAuto(t, { now: at(61) })
  // 人が確認すれば、数えなくなる。確認済みのルールを編集すると、また未確認になる
  for (const c of note(t, ['review', '--session', 'human-1'], { now: at(62) }).json.unreviewed) {
    assert.match(note(t, ['review', 'done', c.id, '--decision', 'keep', '--session', 'human-1'], { now: at(63) }).stdout, /確認済みにしました/)
  }
  assert.equal(note(t, ['status', '--json']).json.gates.unreviewed, 0)
  note(t, ['trial', 'edit', '--session', 'human-2', '--key', 'second-key', '--text', '書き換えた決まり'], { now: at(64) })
  assert.deepEqual(note(t, ['review', '--session', 'human-1'], { now: at(65) }).json.unreviewed.map((c) => [c.kind, c.cause_key]), [['trial_edit', 'second-key']])
  // 消せば、未確認からも外れる
  note(t, ['trial', 'remove', '--session', 'human-1', '--key', 'second-key'], { now: at(66) })
  assert.equal(note(t, ['status', '--json']).json.gates.unreviewed, 0)
})

test('1 つのセッションが 2 つの ID を名乗って、自動改善の対象を作ることはできない', () => {
  const t = makeEnv()
  const add = (session, opts = {}) => note(t, ['add', '--session', session, '--category', 'dev/mistake', '--key', 'planted-key', '--text', `${session} の気づき`], { known: false, ...opts })
  // hook が記録していないセッションの ID は受け付けない
  for (const fake of ['fake-a', 'fake-b']) {
    const run = add(fake)
    assert.equal(run.status, 0)
    assert.match(run.stdout, /記録しません：セッション fake-. は、このプラグインの hook に記録されていません/)
  }
  assert.deepEqual(dataFiles(t, 'candidates'), [])
  // 実在する別のセッションの ID を名乗っても、hook が引き渡した自分の ID と食い違うので受け付けない
  knownSession(t, 'real-1')
  knownSession(t, 'real-2')
  const impersonated = add('real-2', { env: { HARNESS_SESSION_ID: 'real-1' } })
  assert.equal(impersonated.status, 1)
  assert.match(impersonated.stderr, /ほかのセッションを名乗ることはできません/)
  // 自分の ID では 1 セッション分にしかならない
  assert.match(add('real-1', { env: { HARNESS_SESSION_ID: 'real-1' } }).stdout, /記録しました/)
  assert.match(note(t, ['add', '--category', 'dev/mistake', '--key', 'planted-key', '--text', '別の言い方'], { env: { HARNESS_SESSION_ID: 'real-1' }, now: at(0, 1) }).stdout, /記録しました/)
  assert.equal(note(t, ['keys', '--json']).json[0].sessions, 1)
  assert.deepEqual(note(t, ['targets', '--json']).json.targets, [])
})

test('1 回 3 件まで：対象はスクリプトが選び、それ以外の原因キーには書き込めない', () => {
  const t = makeEnv({ config: AUTO })
  seedCandidates(t, 'key-four-sessions', ['a1', 'a2', 'a3', 'a4'], { now: at(0) })
  seedCandidates(t, 'key-three-sessions', ['b1', 'b2', 'b3'], { now: at(1) })
  seedCandidates(t, 'key-two-newer', ['c1', 'c2'], { now: at(3) })
  seedCandidates(t, 'key-two-older', ['d1', 'd2'], { now: at(2) })
  const lock = note(t, ['lock', '--session', 'auto-1', '--json'], { now: at(60) }).json
  assert.deepEqual(lock.lock.targets.map((x) => x.key), ['key-four-sessions', 'key-three-sessions', 'key-two-newer'])

  const outside = draft(t, 'key-two-older')
  assert.equal(outside.status, 0)
  assert.match(outside.stdout, /見送り：key-two-older は、今回の対象ではありません/)
  assert.match(trialAdd(t, 'key-two-older').stdout, /見送り/)
  assert.match(trialAdd(t, 'never-recorded').stdout, /見送り/)
  assert.deepEqual(dataFiles(t, 'pending'), [])
  assert.deepEqual(dataFiles(t, 'trial'), [])
  // 対象外の候補は new のまま残り、次の回に回る
  assert.equal(note(t, ['list', '--key', 'key-two-older', '--json']).json.length, 2)
})

test('自動の追加：下書き → 試用ルールの順。材料にした候補は consumed になり、数え直さない。1 つの原因に変換は 1 つ', () => {
  const t = makeEnv({ config: AUTO })
  startAuto(t, ['route-placement'])
  // 下書きがないうちは追加しない
  assert.match(trialAdd(t, 'route-placement').stdout, /見送り：先に pending add/)

  const pending = draft(t, 'route-placement')
  assert.match(pending.stdout, /失敗票の下書きを書きました：route-placement（材料にした候補 2 件を consumed にしました）/)
  assert.deepEqual(note(t, ['list', '--status', 'consumed', '--json']).json.map((c) => c.consumed_by), ['pending:route-placement', 'pending:route-placement'])
  assert.deepEqual(note(t, ['list', '--json']).json, [])

  const added = trialAdd(t, 'route-placement', {}, 'ルート定義は src/routes/ に置く')
  assert.match(added.stdout, /試用ルールを追加しました：- ルート定義は src\/routes\/ に置く（下書き:route-placement）/)
  assert.equal(note(t, ['trial', 'list', '--json']).json[0].by, 'auto')

  const text = readData(t, 'pending', repoId(t), 'route-placement.md')
  assert.match(text, /^id: DRAFT-route-placement$/m)
  assert.match(text, /^category: dev\/mistake$/m)
  assert.match(text, /^root_cause: knowledge$/m)
  assert.match(text, /^status: trial$/m)
  assert.match(text, /^control: trial:rules\/route-placement$/m)
  assert.match(text, /^applied_by: auto$/m)
  for (const heading of ['## 何を頼んだか', '## 期待した結果', '## 実際の結果', '## 根拠']) assert.ok(text.includes(heading), heading)
  assert.match(text, /改善候補 c-/)

  // 同じ原因に 2 つ目の変換は入れない
  assert.match(note(t, ['trial', 'edit', '--session', 'auto-1', '--key', 'route-placement', '--text', '言い換え'], { now: at(63) }).stdout, /見送り：route-placement には、この実行ですでに対策を入れました/)
  assert.match(note(t, ['skill', 'add', '--session', 'auto-1', '--key', 'route-placement', '--name', 'routes', '--description', 'demo-app で使う', '--body', '手順'], { now: at(63) }).stdout, /見送り/)
  // 自動改善のセッションでは消さない。候補の状態の変更、キーのまとめ直し、下書きの破棄もしない
  assert.match(note(t, ['trial', 'remove', '--session', 'auto-1', '--key', 'route-placement']).stdout, /見送り：自動改善のセッションでは、試用を消しません/)
  for (const args of [['mark', '--key', 'route-placement', '--status', 'rejected'], ['rekey', 'route-placement', 'other-key'], ['pending', 'remove', 'route-placement']]) {
    assert.match(note(t, [...args, '--session', 'auto-1'], { now: at(63) }).stdout, /見送り：自動改善のセッションでは、この操作は行いません/, args.join(' '))
  }
  assert.ok(note(t, ['pending', 'show', 'route-placement']).stdout.includes('DRAFT-route-placement'))

  // 未確認として登録され、次の回でも同じ候補は数え直さない
  const status = note(t, ['status', '--json', '--session', 'auto-1'], { now: at(64) }).json
  assert.equal(status.gates.unreviewed, 1)
  assert.deepEqual(status.targets, [])
  // リポジトリの中には何も書かない
  assert.equal(existsSync(join(t.repo, 'harness/incidents')), false)
})

test('下書きは、その実行で作ったものだけを認める（前の実行の下書きが残っていても、下書きなしで試用を足したり編集したりできない）', () => {
  const t = makeEnv({ config: AUTO })
  startAuto(t, ['route-placement'])
  draft(t, 'route-placement')
  assert.match(trialAdd(t, 'route-placement').stdout, /追加しました/)
  finishAuto(t, { now: at(63) })
  // 人は試用を残したまま、下書きも残っている。次の回に、同じ原因が再発として対象になる
  assert.equal(note(t, ['pending', 'show', 'route-placement']).status, 0)
  seedCandidates(t, 'route-placement', ['later-1', 'later-2'], { now: at(0, 5) })
  seedCandidates(t, 'second-key', ['later-3', 'later-4'], { now: at(1, 5) })
  const lock = note(t, ['lock', '--session', 'auto-2'], { now: at(0, 8) })
  assert.match(lock.stdout, /route-placement.*再発（1 回目）/)
  // 前の実行の下書きがあるだけでは、編集できない
  const early = note(t, ['trial', 'edit', '--session', 'auto-2', '--key', 'route-placement', '--text', '書き換えた 1 行'], { now: at(1, 8) })
  assert.match(early.stdout, /見送り：先に pending add で route-placement の失敗票の下書きを作ってください（前の実行の下書きが残っていても、この実行で作り直します）/)
  assert.equal(note(t, ['trial', 'list', '--json']).json[0].text, 'route-placement の決まりを守る')
  // この実行で下書きを作れば、編集できる
  assert.match(draft(t, 'route-placement', { session: 'auto-2', now: at(2, 8) }).stdout, /再発として数えました（1 回目）/)
  assert.match(note(t, ['trial', 'edit', '--session', 'auto-2', '--key', 'route-placement', '--text', '書き換えた 1 行'], { now: at(3, 8) }).stdout, /更新しました/)
})

test('未確認の上限：達したら、追加も編集も下書きもやめて報告だけにする', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7, max_unreviewed: 2 } } })
  startAuto(t, ['key-aaa', 'key-bbb', 'key-ccc'])
  for (const key of ['key-aaa', 'key-bbb']) {
    draft(t, key)
    assert.match(trialAdd(t, key).stdout, /追加しました/)
  }
  const blocked = draft(t, 'key-ccc')
  assert.match(blocked.stdout, /見送り：未確認の自動変更が 2 件あります（上限 2 件）。追加も編集もせず、報告だけにしてください/)
  assert.match(trialAdd(t, 'key-ccc').stdout, /見送り：未確認の自動変更が 2 件/)
  assert.equal(note(t, ['list', '--key', 'key-ccc', '--json']).json.length, 2)
  // 報告は書ける
  assert.match(note(t, ['report', 'write', '--session', 'auto-1', '--body', 'key-ccc は未確認の上限のため見送り'], { now: at(65) }).stdout, /実行の記録を書きました/)
  note(t, ['unlock', '--session', 'auto-1'], { now: at(66) })

  // 次の回：ロックの時点で上限に達していることを伝える
  const next = note(t, ['lock', '--session', 'auto-2'], { now: at(0, 8) })
  assert.match(next.stdout, /未確認の自動変更：2 件（上限 2 件） → 上限に達しています。追加も編集もせず、報告だけにしてください/)
  assert.match(draft(t, 'key-ccc', { session: 'auto-2', now: at(1, 8) }).stdout, /見送り/)

  // 自動改善の実行中は、確認の結果も記録しない（終わってから行う）
  const id = note(t, ['review']).json.unreviewed[0].id
  assert.match(note(t, ['review', 'done', id, '--decision', 'keep', '--session', 'human-1'], { now: at(2, 8) }).stdout, /見送り：自動改善が実行中です/)
  finishAuto(t, { session: 'auto-2', now: at(3, 8), body: '未確認の上限のため見送り' })

  // 人が 1 件確認すると、次の回には、また追加できる
  assert.match(note(t, ['review', 'done', id, '--decision', 'keep', '--session', 'human-1'], { now: at(4, 8) }).stdout, /確認済みにしました/)
  assert.match(note(t, ['lock', '--session', 'auto-3'], { now: at(0, 15) }).stdout, /未確認の自動変更：1 件（上限 2 件）\n/)
  assert.match(draft(t, 'key-ccc', { session: 'auto-3', now: at(1, 15) }).stdout, /下書きを書きました/)
})

test('試用ルール・試用Skill の上限：実行の途中で達したら、それ以上は追加しない', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7, max_trial_rules: 1, max_trial_skills: 1 } } })
  startAuto(t, ['key-aaa', 'key-bbb', 'key-ccc'])
  for (const key of ['key-aaa', 'key-bbb', 'key-ccc']) draft(t, key)
  assert.match(trialAdd(t, 'key-aaa').stdout, /追加しました/)
  assert.match(trialAdd(t, 'key-bbb').stdout, /見送り：試用ルールが上限（1 件）に達しています/)
  const skill = (key, name) => note(t, ['skill', 'add', '--session', 'auto-1', '--key', key, '--name', name, '--description', 'demo-app リポジトリで使う', '--body', '手順を書く'], { now: at(63) })
  assert.match(skill('key-bbb', 'skill-b').stdout, /試用 Skill を追加しました/)
  assert.match(skill('key-ccc', 'skill-c').stdout, /見送り：試用 Skill が上限（1 件）に達しています/)
  assert.equal(note(t, ['status', '--json']).json.gates.trial_skills, 1)
})

test('行数の歯止め：見るのは「paths なしのルール＋試用ルール」だけ。CLAUDE.md が長くても、自動改善は止まらない', () => {
  const t = makeEnv({
    config: AUTO,
    files: {
      'CLAUDE.md': Array.from({ length: 160 }, (_, i) => `- 行 ${i}`).join('\n'),
      '.claude/rules/always.md': '- いつも読むルール\n',
      '.claude/rules/scoped.md': `---\npaths:\n  - "src/**"\n---\n${'- 絞ったルール\n'.repeat(60)}`,
    },
  })
  const lock = startAuto(t, ['route-placement'])
  assert.match(lock.stdout, /常時ロードのルール 1\/50 行/)
  draft(t, 'route-placement')
  assert.match(trialAdd(t, 'route-placement').stdout, /追加しました/)
  // paths 付きのルールと CLAUDE.md は、歯止めの行数に数えない
  const gates = note(t, ['status', '--json']).json.gates
  assert.deepEqual([gates.rule_lines, gates.rule_limit, gates.claude_md_lines, gates.claude_md_limit], [2, 50, 160, 100])
})

test('行数の歯止めに掛かる対象は、lock の時点で「追加できない」と分かり、下書きで候補を消費しない', () => {
  const t = makeEnv({
    config: { auto: { interval_days: 7, max_trial_skills: 0 }, budget: { always_loaded_rule_lines: 3 } },
    files: { '.claude/rules/always.md': '- a\n- b\n- c\n' },
  })
  const lock = startAuto(t, ['route-placement'])
  assert.match(lock.stdout, /route-placement（dev\/mistake、2 セッション）— 新規。ただし、いまは追加できません（常時ロードのルールが行数の目安を超えます（paths なしのルール 3 行＋試用ルール 0 行、目安 3 行）/)
  const target = note(t, ['lock', '--session', 'auto-1', '--json'], { now: at(61) }).json.lock.targets[0]
  assert.deepEqual([target.allowed, Boolean(target.blocked)], [[], true])

  // 下書きを作らせない。候補は new のまま残る
  const refused = draft(t, 'route-placement')
  assert.match(refused.stdout, /見送り：route-placement には、いま試用を追加できません.*下書きは作らず、候補は残します/)
  assert.deepEqual(dataFiles(t, 'pending'), [])
  assert.equal(note(t, ['list', '--key', 'route-placement', '--json']).json.length, 2)
  assert.equal(note(t, ['status', '--json']).json.gates.unreviewed, 0)
  // 案を載せるとき（ガードや検証コマンドへ移す案）と、対策を入れない記録は、歯止めに関係なく作れる
  assert.match(draft(t, 'route-placement', { extra: ['--proposal-kind', 'guard', '--proposal', 'src/api/ への Write を止める'] }).stdout, /承認待ちの案として登録しました/)
  finishAuto(t)
  // 理由は記録にも残る
  assert.match(note(t, ['report', 'show']).stdout, /route-placement（dev\/mistake、2 セッション、追加できない：常時ロードのルールが行数の目安を超えます/)

  // 試用ルールは足せないが、試用 Skill は足せる場合：skill add だけを案内する
  const t2 = makeEnv({ config: { auto: { interval_days: 7 }, budget: { always_loaded_rule_lines: 3 } }, files: { '.claude/rules/always.md': '- a\n- b\n- c\n' } })
  const lock2 = startAuto(t2, ['migration-forgotten'])
  assert.match(lock2.stdout, /新規。skill add だけ（常時ロードのルールが行数の目安を超えます/)
  assert.match(draft(t2, 'migration-forgotten').stdout, /下書きを書きました/)
  assert.match(trialAdd(t2, 'migration-forgotten').stdout, /見送り：常時ロードのルールが行数の目安を超えます/)
})

test('再発：1 回目だけ試用ルールを編集してよい。2 回目以降は編集せず、案だけ。再発は編集したかにかかわらず数える', () => {
  const t = makeEnv({ config: AUTO })
  startAuto(t, ['route-placement'])
  draft(t, 'route-placement')
  trialAdd(t, 'route-placement', {}, 'ルート定義は src/routes/ に置く')
  // 同じ実行で、試用を入れたあとに案を足しても、再発には数えない
  const sameRun = draft(t, 'route-placement', { now: at(63), extra: ['--proposal-kind', 'guard', '--proposal', 'src/api/ への Write を止める'] })
  assert.doesNotMatch(sameRun.stdout, /再発として数えました/)
  assert.match(readData(t, 'pending', repoId(t), 'route-placement.md'), /# 追記（2026-11-16）/)
  finishAuto(t, { now: at(70) })

  // 試用中に、同じ原因がまた 2 セッションで出た → 再発の 1 回目
  seedCandidates(t, 'route-placement', ['r1', 'r2'], { now: at(0, 3) })
  const second = note(t, ['lock', '--session', 'auto-2', '--json'], { now: at(0, 8) }).json
  assert.deepEqual(second.lock.targets.map((x) => [x.key, x.mode, x.recurrence_no, x.allowed]), [['route-placement', 'recurrence', 1, ['trial edit']]])
  const d2 = draft(t, 'route-placement', { session: 'auto-2', now: at(1, 8) })
  assert.match(d2.stdout, /試用中の原因の再発として数えました（1 回目）/)
  // 同じ実行で下書きを 2 回書いても、再発は 1 回分
  assert.doesNotMatch(draft(t, 'route-placement', { session: 'auto-2', now: at(1, 8) }).stdout, /再発として数えました/)
  assert.match(trialAdd(t, 'route-placement', { session: 'auto-2', now: at(2, 8) }).stdout, /見送り：route-placement は試用中の原因の再発（1 回目）です。再発の 1 回目なので、trial edit で文言を直せます/)
  const edited = note(t, ['trial', 'edit', '--session', 'auto-2', '--key', 'route-placement', '--text', 'Hono のルート定義は、必ず src/routes/ の下に置く'], { now: at(3, 8) })
  assert.match(edited.stdout, /更新しました/)
  assert.match(readData(t, 'pending', repoId(t), 'route-placement.md'), /# 再発（2026-11-24）/)
  note(t, ['report', 'write', '--session', 'auto-2', '--body', '再発・編集'], { now: at(4, 8) })
  assert.match(note(t, ['report', 'show']).stdout, /自動改善（11\/24）：1件を編集。/)
  assert.match(note(t, ['report', 'show']).stdout, /試用ルールを編集（route-placement、再発）/)
  assert.match(note(t, ['unlock', '--session', 'auto-2'], { now: at(5, 8) }).stdout, /解除しました/)

  // さらにまた出た → 2 回目。編集しない
  seedCandidates(t, 'route-placement', ['r3', 'r4'], { now: at(0, 10) })
  const third = note(t, ['lock', '--session', 'auto-3', '--json'], { now: at(0, 16) }).json
  assert.deepEqual(third.lock.targets.map((x) => [x.mode, x.recurrence_no, x.allowed]), [['recurrence', 2, []]])
  const d3 = draft(t, 'route-placement', {
    session: 'auto-3', now: at(1, 16),
    extra: ['--proposal-kind', 'guard', '--proposal', 'src/api/ への Write を止めるガード。テスト：src/api/user.ts は deny、src/routes/user.ts は allow'],
  })
  assert.match(d3.stdout, /再発として数えました（2 回目）/)
  assert.match(d3.stdout, /承認待ちの案として登録しました/)
  const refused = note(t, ['trial', 'edit', '--session', 'auto-3', '--key', 'route-placement', '--text', '3 度目の言い換え'], { now: at(2, 16) })
  assert.match(refused.stdout, /見送り：route-placement は試用中の原因の再発（2 回目）です。再発の 2 回目以降/)
  assert.equal(note(t, ['trial', 'list', '--json']).json[0].edits, 1)
  note(t, ['report', 'write', '--session', 'auto-3', '--body', 'ガードへ移す案'], { now: at(3, 16) })
  const report = note(t, ['report', 'show']).stdout
  assert.match(report, /自動改善（12\/2）：承認待ちの案が1件。/)
  assert.match(report, /再発した原因：1 件\n {2}- route-placement（2 回）/)
})

test('report write: lock したセッションだけが書ける。報告に載せるだけのもの（バグ・好み・その他）も並べる', () => {
  const t = makeEnv({ config: AUTO })
  seedCandidates(t, 'null-check-missing', ['b1'], { category: 'dev/bug' })
  seedCandidates(t, 'misc-note', ['o1'], { category: 'dev/other' })
  seedCandidates(t, 'prefers-pnpm', ['p1', 'p2', 'p3'], { category: 'behavior/preference' })
  seedCandidates(t, 'prefers-tabs', ['q1', 'q2'], { category: 'behavior/preference' })
  startAuto(t, ['route-placement', 'migration-forgotten'])

  const stranger = note(t, ['report', 'write', '--session', 'human-1', '--body', 'x'], { now: at(61) })
  assert.equal(stranger.status, 1)
  assert.match(stranger.stderr, /lock で登録した自動改善のセッションだけ/)

  draft(t, 'route-placement')
  trialAdd(t, 'route-placement')
  draft(t, 'migration-forgotten')
  note(t, ['skill', 'add', '--session', 'auto-1', '--key', 'migration-forgotten', '--name', 'db-migration', '--description', 'demo-app でスキーマを変えるときに使う', '--body', '手順'], { now: at(63) })
  const body = '## route-placement\\n- 根拠：候補 2 件。事象メモなし\\n- 照らし合わせた既存のルール：CLAUDE.md（矛盾なし）'
  const written = note(t, ['report', 'write', '--session', 'auto-1', '--body', body], { now: at(65) })
  assert.match(written.stdout, /実行の記録を書きました：auto-2026-11-16/)
  assert.match(written.stdout, /自動改善（11\/16）：試用ルールを1件追加、試用Skillを1件追加。バグの候補が1件。確認したい好みの候補が1件。/)
  assert.deepEqual(dataFiles(t, 'reports'), [`${repoId(t)}/auto-2026-11-16.md`])
  const report = readData(t, 'reports', repoId(t), 'auto-2026-11-16.md')
  assert.match(report, /- route-placement（dev\/mistake、2 セッション）/)
  assert.match(report, /- 試用ルールを追加（route-placement）/)
  assert.match(report, /- 試用Skillを追加（migration-forgotten）：demo-app-db-migration/)
  assert.match(report, /- 根拠：候補 2 件。事象メモなし\n- 照らし合わせた既存のルール/)
  assert.match(report, /バグの候補（dev\/bug）：1 件\n {2}- c-.*［null-check-missing］/)
  assert.match(report, /その他の気づき（dev\/other）：1 件/)
  assert.match(report, /確認したい好みの候補（3 セッション以上）：1 件\n {2}- prefers-pnpm（3 セッション）/)
  assert.doesNotMatch(report, /prefers-tabs/)
  assert.deepEqual(note(t, ['report', 'list', '--json']).json.map((r) => [r.name, r.counts.trial_add, r.counts.skill_add, r.closed_at]), [['auto-2026-11-16', 1, 1, null]])
})

test('review: 未確認の自動変更を中身つきで並べ、残す・消す・昇格するを記録する', () => {
  const t = makeEnv({ config: AUTO })
  startAuto(t, ['key-keep', 'key-remove', 'key-promote'])
  for (const key of ['key-keep', 'key-remove', 'key-promote']) {
    draft(t, key)
    trialAdd(t, key)
  }
  // 自動改善のセッションは、自分で確認済みにできない
  const items = note(t, ['review'], { now: at(0, 2) }).json
  assert.match(note(t, ['review', 'done', items.unreviewed[0].id, '--decision', 'keep', '--session', 'auto-1'], { now: at(64) }).stdout, /見送り：自動改善のセッションでは、確認の結果を記録しません/)
  note(t, ['report', 'write', '--session', 'auto-1', '--body', '3 件'], { now: at(65) })
  note(t, ['unlock', '--session', 'auto-1'], { now: at(66) })

  assert.equal(items.unreviewed.length, 3)
  assert.equal(items.oldest_days, 1)
  assert.equal(items.next_incident_id, 'INC-2026-0001')
  const byKey = Object.fromEntries(items.unreviewed.map((i) => [i.cause_key, i]))
  assert.equal(byKey['key-keep'].kind, 'trial_add')
  assert.equal(byKey['key-keep'].rule.line, '- key-keep の決まりを守る（下書き:key-keep）')
  assert.match(byKey['key-keep'].draft, /## 実際の結果/)

  // 残す：失敗票を harness/incidents/ に置いた前提で、ID を付け替え、下書きを捨てる
  writeFiles(t.repo, { 'harness/incidents/INC-2026-0001.md': '---\nid: INC-2026-0001\ncause_key: key-keep\nstatus: trial\ncontrol: trial:rules/key-keep\n---\n' })
  const keep = note(t, ['review', 'done', byKey['key-keep'].id, '--decision', 'keep', '--incident', 'INC-2026-0001', '--session', 'human-1'], { now: at(1, 2) })
  assert.match(keep.stdout, /試用ルールの失敗票 ID を INC-2026-0001 にしました/)
  assert.match(note(t, ['trial', 'list']).stdout, /- key-keep の決まりを守る（INC-2026-0001）/)

  // 消す：試用を消し、下書きを捨て、その原因を「断られた」と記録する
  const remove = note(t, ['review', 'done', byKey['key-remove'].id, '--decision', 'remove', '--session', 'human-1'], { now: at(2, 2) })
  assert.match(remove.stdout, /試用ルールを消しました/)
  assert.match(remove.stdout, /失敗票の下書きを捨てました/)
  assert.match(remove.stdout, /「断られた」と記録しました/)
  // 断られた原因は、新しい候補が 2 件たまるまで対象にしない
  seedCandidates(t, 'key-remove', ['x1'], { now: at(0, 3) })
  assert.deepEqual(note(t, ['targets', '--json']).json.targets, [])
  seedCandidates(t, 'key-remove', ['x2'], { now: at(1, 3) })
  assert.deepEqual(note(t, ['targets', '--json']).json.targets.map((x) => [x.key, x.mode]), [['key-remove', 'new']])

  // 昇格する：.claude/rules/ へ移した前提で、試用を消す。その後の再発は、編集せず案だけ
  const promote = note(t, ['review', 'done', byKey['key-promote'].id, '--decision', 'promote', '--path', '.claude/rules/promote.md', '--session', 'human-1'], { now: at(3, 2) })
  assert.match(promote.stdout, /試用ルールを消しました/)
  assert.deepEqual(note(t, ['trial', 'list', '--json']).json.map((r) => r.cause_key), ['key-keep'])
  seedCandidates(t, 'key-promote', ['y1', 'y2'], { now: at(2, 3) })
  const promoted = note(t, ['targets', '--json']).json.targets.find((x) => x.key === 'key-promote')
  assert.deepEqual([promoted.mode, promoted.trial, promoted.allowed], ['recurrence', 'promoted', []])

  const after = note(t, ['review']).json
  assert.deepEqual(after.unreviewed, [])
  assert.deepEqual(note(t, ['status', '--json']).json.decisions, { kept: 2, removed: 1 })
  assert.deepEqual(dataFiles(t, 'pending'), [])
  assert.equal(note(t, ['review', 'done', 'a-nope', '--decision', 'keep', '--session', 'human-1']).status, 1)
  assert.equal(note(t, ['review', 'done', byKey['key-keep'].id, '--decision', 'whatever', '--session', 'human-1']).status, 1)
})

test('pending add: 分類と項目を検査する。本文は 4 見出しで、同じ原因の失敗票を related に入れる', () => {
  const t = makeEnv({ files: { 'harness/incidents/INC-2026-0003.md': '---\nid: INC-2026-0003\ncause_key: route-placement\nstatus: converted\ncontrol: .claude/rules/routes.md\n---\n' } })
  seedCandidates(t, 'route-placement', ['s1'], { now: at(0) })
  const base = ['pending', 'add', '--session', 'human-1', '--key', 'route-placement', '--asked', 'a', '--expected', 'b', '--actual', 'c']
  assert.equal(note(t, [...base, '--root-cause', 'laziness']).status, 1)
  assert.equal(note(t, [...base]).status, 1)
  assert.equal(note(t, [...base, '--root-cause', 'knowledge', '--signal', 'vibes']).status, 1)
  assert.equal(note(t, [...base, '--root-cause', 'knowledge', '--proposal-kind', 'cron', '--proposal', 'x']).status, 1)
  assert.equal(note(t, [...base, '--root-cause', 'knowledge', '--proposal-kind', 'guard']).status, 1)
  const ok = note(t, [...base, '--root-cause', 'forbidden', '--signal', 'guard_denied', '--severity', 'high', '--area', 'backend', '--evidence', 'コミット abc123'], { now: at(5) })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /同じ原因の失敗票：INC-2026-0003/)
  const text = note(t, ['pending', 'show', 'route-placement']).stdout
  assert.match(text, /^related: \[INC-2026-0003\]$/m)
  assert.match(text, /^severity: high$/m)
  assert.match(text, /^area: backend$/m)
  assert.match(text, /^applied_by: human$/m)
  assert.match(text, /コミット abc123/)
  assert.deepEqual(note(t, ['pending', 'list', '--json']).json, ['route-placement'])
  assert.match(note(t, ['pending', 'remove', 'route-placement']).stdout, /捨てました/)
  assert.equal(note(t, ['pending', 'show', 'route-placement']).status, 1)
  assert.equal(readFileSync(join(t.repo, 'harness/incidents/INC-2026-0003.md'), 'utf8').includes('converted'), true)
})

test('対策を入れなかった記録（環境が原因など）と、試用に添えた案も、未確認の自動変更として人に見せる', () => {
  const t = makeEnv({ config: AUTO })
  startAuto(t, ['flaky-e2e', 'route-placement'])
  const recorded = note(t, ['pending', 'add', '--session', 'auto-1', '--key', 'flaky-e2e', '--root-cause', 'environment', '--asked', 'E2E を通して', '--expected', '通る', '--actual', 'たまに落ちる'], { now: at(61) })
  assert.match(recorded.stdout, /下書きを書きました/)
  // 下書きに試用が続いても、未確認は 1 つの原因につき 1 件
  draft(t, 'route-placement', { extra: ['--proposal-kind', 'guard', '--proposal', 'src/api/ への Write を止める'] })
  trialAdd(t, 'route-placement')
  assert.equal(note(t, ['status', '--json']).json.gates.unreviewed, 2)
  const written = note(t, ['report', 'write', '--session', 'auto-1', '--body', 'flaky-e2e は環境が原因'], { now: at(65) })
  assert.match(written.stdout, /自動改善（11\/16）：試用ルールを1件追加。承認待ちの案が1件。対策を入れなかった記録が1件。/)
  note(t, ['unlock', '--session', 'auto-1'], { now: at(66) })

  const items = note(t, ['review']).json
  assert.deepEqual(items.unreviewed.map((i) => [i.cause_key, i.kind, i.proposal]), [['flaky-e2e', 'draft', false], ['route-placement', 'trial_add', true]])
  assert.match(items.unreviewed[0].draft, /^root_cause: environment$/m)
  assert.match(items.unreviewed[1].draft, /## 承認待ちの案（ガード）\n\nsrc\/api\/ への Write を止める/)
  assert.deepEqual(items.other_drafts, [])

  // 直す：文言を直して残す（失敗票の ID を付け替える）
  note(t, ['trial', 'edit', '--session', 'human-1', '--key', 'route-placement', '--text', 'ルート定義は src/routes/ に置く'], { now: at(0, 1) })
  const edited = note(t, ['review', 'done', items.unreviewed[1].id, '--decision', 'edit', '--incident', 'INC-2026-0001', '--session', 'human-1'], { now: at(1, 1) })
  assert.match(edited.stdout, /失敗票 ID を INC-2026-0001 にしました/)
  // 対応しない：下書きを捨て、その原因を「断られた」と記録する
  const dismissed = note(t, ['review', 'done', items.unreviewed[0].id, '--decision', 'dismiss', '--session', 'human-1'], { now: at(2, 1) })
  assert.match(dismissed.stdout, /下書きを捨てました/)
  assert.match(dismissed.stdout, /「断られた」/)
  assert.deepEqual(note(t, ['review']).json.unreviewed, [])
  assert.deepEqual(dataFiles(t, 'pending'), [])
  assert.deepEqual(note(t, ['status', '--json']).json.decisions, { kept: 1, removed: 1 })
})
