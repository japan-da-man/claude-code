// 昇格。試用を、自分専用（user 側に置く。ほかの人には影響しない）か、チーム（リポジトリのファイル）へ移す。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { at, decisionOf, draft, finishAuto, guardRun, humanTrial, makeEnv, note, session, startAuto, writeFiles } from './helpers.mjs'

const INCIDENT = ['incident', 'add', '--session', 'human-1', '--root-cause', 'knowledge', '--category', 'dev/mistake',
  '--asked', 'ユーザー一覧の API を足す', '--expected', 'src/routes/ にルートを置く', '--actual', 'src/api/ に置いた']
const issue = (t, key, extra = []) => /INC-\d{4}-\d{4}/.exec(note(t, [...INCIDENT, '--key', key, ...extra]).stdout)[0]
const incident = (t, id) => readFileSync(join(t.user, 'incidents', `${id}.md`), 'utf8')
const personalRules = (t) => join(t.user, 'repos', t.name, 'rules.md')
// 自分専用のルールのファイルは、見出しと説明のあとに、「- 」で始まる行が 1 行 1 ルールで並ぶ。
const ruleLines = (t) => readFileSync(personalRules(t), 'utf8').split('\n').filter((l) => l.startsWith('- '))
const trialKeys = (t) => note(t, ['trial', 'list', '--json']).json.map((r) => r.cause_key)
const promote = (t, args, opts) => note(t, ['promote', '--session', 'human-1', ...args], opts)

test('promote --to personal: 試用ルールを、自分専用のルール（user 側）に移す。リポジトリには何も書かない', () => {
  const t = makeEnv()
  const id = issue(t, 'route-placement', ['--status', 'trial', '--control', 'trial:rules/route-placement'])
  humanTrial(t, 'route-placement', 'ルート定義は src/routes/ に置く', { ref: id })
  const run = promote(t, ['--key', 'route-placement', '--to', 'personal'], { now: at(0, 3) })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /^route-placement を自分専用へ昇格しました。\n自分専用のルールに足しました：- ルート定義は src\/routes\/ に置く（INC-2026-0001）（~\/\.claude\/self-improve\/repos\/demo-app\/rules\.md）。このリポジトリのセッション開始時に読み込みます\n失敗票 INC-2026-0001 を converted にしました\n/)
  assert.deepEqual(ruleLines(t), ['- ルート定義は src/routes/ に置く（INC-2026-0001）'])
  assert.deepEqual(trialKeys(t), [])
  // 試用ルールが参照していた失敗票が、converted になる（--incident を付けなくても）
  assert.match(incident(t, id), /^status: converted$/m)
  assert.match(incident(t, id), /^control: personal:~\/\.claude\/self-improve\/repos\/demo-app\/rules\.md$/m)
  assert.match(incident(t, id), /^promoted_at: 2026-11-19$/m)
  assert.ok(!existsSync(join(t.repo, '.claude')) && !existsSync(join(t.repo, 'harness')))
  // 次のセッションから、自分専用のルールとして読み込む（試用ルールとしてではなく）
  const context = session(t, 'next').start().json.hookSpecificOutput.additionalContext
  assert.match(context, /あなた（ユーザー）が自分専用に決めたルールです。[^\n]*\n- ルート定義は src\/routes\/ に置く（INC-2026-0001）/)
  assert.doesNotMatch(context, /試用中のルール/)
  // review には、昇格済みとして出る（確認の対象ではない）
  const review = note(t, ['review', '--json', '--session', 'human-1']).json
  assert.deepEqual(review.promoted.map((p) => [p.cause_key, p.to]), [['route-placement', 'personal']])
  assert.deepEqual(review.unreviewed, [])
  // 同じ昇格を 2 回はできない（試用が、もうない）
  const again = promote(t, ['--key', 'route-placement', '--to', 'personal'])
  assert.equal(again.status, 1)
  assert.match(again.stderr, /route-placement の試用（ルールも Skill も）がありません/)
  assert.deepEqual(ruleLines(t), ['- ルート定義は src/routes/ に置く（INC-2026-0001）'])
})

test('promote --to personal: 未確認の試用も、見直しの時期が来た試用も昇格できる（昇格で、確認済みにもなる）', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7 }, trial_review_days: 14 } })
  startAuto(t, ['route-placement'])
  draft(t, 'route-placement')
  note(t, ['trial', 'add', '--session', 'auto-1', '--key', 'route-placement', '--text', 'ルート定義は src/routes/ に置く'], { now: at(62) })
  finishAuto(t)
  // 自動改善が入れたまま、見直しの時期（14 日）を過ぎた
  const before = note(t, ['review', '--json', '--session', 'human-1'], { now: at(0, 20) }).json
  assert.deepEqual(before.stale_trials.map((s) => s.key), ['route-placement'])
  assert.equal(before.unreviewed.length, 1)

  // 下書きから起票して、その票を指して昇格する
  const issued = note(t, ['incident', 'add', '--from-draft', '--key', 'route-placement', '--session', 'human-1'], { now: at(1, 20) })
  const id = /INC-\d{4}-\d{4}/.exec(issued.stdout)[0]
  const run = promote(t, ['--key', 'route-placement', '--to', 'personal', '--incident', id], { now: at(2, 20) })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(ruleLines(t), [`- ルート定義は src/routes/ に置く（${id}）`])
  const after = note(t, ['review', '--json', '--session', 'human-1'], { now: at(3, 20) }).json
  assert.deepEqual([after.unreviewed, after.stale_trials], [[], []])
  assert.match(incident(t, id), /^status: converted$/m)
  // 未確認が残らないので、自動改善は止まらない
  assert.deepEqual(after.auto_blocked, [])
})

test('promote --to personal: 失敗票がない・別のリポジトリのもの・下書きが残っている、のときの扱い', () => {
  const t = makeEnv()
  humanTrial(t, 'route-placement', 'ルート定義は src/routes/ に置く')
  const missing = promote(t, ['--key', 'route-placement', '--to', 'personal', '--incident', 'INC-2026-0042'])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /失敗票 INC-2026-0042 がありません/)
  // 別のリポジトリの票は、書き換えない
  const other = { ...t, repo: join(t.base, 'other-app'), name: 'other-app' }
  mkdirSync(join(other.repo, '.git'), { recursive: true })
  const foreign = issue(other, 'route-placement')
  const refused = promote(t, ['--key', 'route-placement', '--to', 'personal', '--incident', foreign])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /別のリポジトリ（other-app）のものです/)
  assert.deepEqual(trialKeys(t), ['route-placement'])
  assert.ok(!existsSync(personalRules(t)))
  assert.match(incident(t, foreign), /^status: open$/m)

  // 失敗票なしでも昇格できる。下書きが残っていれば、どうするかを案内する
  note(t, ['pending', 'add', '--session', 'human-1', '--key', 'route-placement', '--category', 'dev/mistake', '--root-cause', 'knowledge', '--asked', 'a', '--expected', 'b', '--actual', 'c'])
  const plain = promote(t, ['--key', 'route-placement', '--to', 'personal'])
  assert.equal(plain.status, 0, plain.stderr)
  assert.match(plain.stdout, /失敗票の下書きが残っています。記録として残すなら harness-note incident add --from-draft --key route-placement/)
  assert.deepEqual(ruleLines(t), ['- ルート定義は src/routes/ に置く'])
  // 引数の検査
  for (const args of [['--key', 'x-y', '--to', 'everyone'], ['--to', 'personal'], ['--key', 'x-y'], ['--key', 'x-y', '--to', 'personal', '--incident', 'INC-1']]) {
    assert.equal(promote(t, args).status, 1, args.join(' '))
  }
})

test('promote --to personal: 試用 Skill は、置き場所を変えずに自分専用にする。昇格したあとは、ガードが編集を止めない', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7 } } })
  startAuto(t, ['migration-forgotten'])
  draft(t, 'migration-forgotten')
  note(t, ['skill', 'add', '--session', 'auto-1', '--key', 'migration-forgotten', '--name', 'db-migration', '--description', 'demo-app でスキーマを変えるときに使う', '--body', '# 手順\n\n1. 生成する\n'], { now: at(63) })
  finishAuto(t)
  const dir = join(t.claudeHome, 'skills', 'demo-app-db-migration')
  const file = join(dir, 'SKILL.md')
  const edit = (path = file) => decisionOf(guardRun(t, 'human-1', 'Edit', { file_path: path, old_string: '生成する', new_string: '生成して確かめる' }, { now: at(0, 1) }))
  const bash = (command) => decisionOf(guardRun(t, 'human-1', 'Bash', { command }, { now: at(0, 1) }))
  // 試用のあいだは、harness-note 以外から書けない
  assert.equal(edit(), 'deny')
  assert.equal(bash(`echo x >> ${file}`), 'deny')

  const id = /INC-\d{4}-\d{4}/.exec(note(t, ['incident', 'add', '--from-draft', '--key', 'migration-forgotten', '--session', 'human-1'], { now: at(0, 1) }).stdout)[0]
  assert.match(incident(t, id), /^control: skill:demo-app-db-migration$/m)
  const before = readFileSync(file, 'utf8')
  const run = promote(t, ['--key', 'migration-forgotten', '--to', 'personal', '--incident', id], { now: at(1, 1) })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /Skill demo-app-db-migration を、自分専用にしました（置き場所はそのまま。試用ではなくなり、直接直せます）/)
  // 置き場所も中身も変わらない。印のファイルに、昇格した日時が入る
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(JSON.parse(readFileSync(join(dir, '.self-improve.json'), 'utf8')).promoted_at, at(1, 1))
  assert.match(incident(t, id), /^status: converted$/m)
  assert.match(incident(t, id), /^control: personal:~\/\.claude\/skills\/demo-app-db-migration$/m)
  // 試用の一覧からは消え、見直しや件数の対象でもなくなる
  assert.deepEqual(note(t, ['skill', 'list', '--json']).json, [])
  assert.deepEqual(note(t, ['review', '--json', '--session', 'human-1'], { now: at(0, 40) }).json.stale_trials, [])
  // 昇格したあとは、ふつうのファイルとして直せる（ガードは止めない。~/.claude の下なので、Claude Code の確認は出る）
  assert.equal(edit(), 'allow')
  assert.equal(bash(`echo x >> ${file}`), 'allow')
  // リンクを通した名前でも、同じ判定になる
  symlinkSync(dir, join(t.base, 'skill-link'))
  assert.equal(edit(join(t.base, 'skill-link', 'SKILL.md')), 'allow')
  // harness-note skill remove は、昇格済みの Skill を消さない
  assert.equal(note(t, ['skill', 'remove', '--session', 'human-1', '--name', 'db-migration']).status, 1)
  assert.ok(existsSync(file))
})

test('promote --to team: 移した先があることを確かめてから、試用を消す（移し忘れのまま消さない）', () => {
  const t = makeEnv()
  const id = issue(t, 'route-placement')
  humanTrial(t, 'route-placement', 'ルート定義は src/routes/ に置く', { ref: id })
  const team = (path) => promote(t, ['--key', 'route-placement', '--to', 'team', ...(path === null ? [] : ['--path', path])], { now: at(0, 2) })
  const still = () => {
    assert.deepEqual(trialKeys(t), ['route-placement'])
    assert.match(incident(t, id), /^status: open$/m)
  }
  // --path がない
  assert.match(team(null).stderr, /--path に、移した先のファイル/)
  still()
  // 移した先のファイルが、まだない
  const missing = team('.claude/rules/routes.md')
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /移した先のファイル（\.claude\/rules\/routes\.md）がありません。.*試用は消していません/)
  still()
  // 空のファイル
  writeFiles(t.repo, { '.claude/rules/routes.md': '\n\n' })
  assert.match(team('.claude/rules/routes.md').stderr, /が空です。試用は消していません/)
  still()
  // リポジトリの外（絶対パス、.. 、リンクの先が外）
  writeFiles(t.base, { 'outside/rules.md': '- ルート定義は src/routes/ に置く\n' })
  symlinkSync(join(t.base, 'outside'), join(t.repo, 'linked'))
  for (const path of [join(t.base, 'outside/rules.md'), '../outside/rules.md', 'linked/rules.md', '.']) {
    const run = team(path)
    assert.equal(run.status, 1, path)
    assert.match(run.stderr, /このリポジトリの中のファイルにしてください|がありません/, path)
    still()
  }
  // 失敗票の ID が残っている（チームへ出すものには付けない。失敗票は、手元にしかない）
  writeFiles(t.repo, { '.claude/rules/routes.md': `# ルート\n\n- ルート定義は src/routes/ に置く（${id}）\n` })
  const leaked = team('.claude/rules/routes.md')
  assert.equal(leaked.status, 1)
  assert.match(leaked.stderr, /失敗票 ID（INC-…）が書かれています。チームへ出すものには付けません/)
  still()

  writeFiles(t.repo, { '.claude/rules/routes.md': '# ルート\n\n- ルート定義は src/routes/ に置く\n' })
  const ok = team('./.claude/rules/routes.md')
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /^route-placement をチームへ昇格しました。\n試用ルールを消しました\n失敗票 INC-2026-0001 を converted にしました\n/)
  assert.deepEqual(trialKeys(t), [])
  assert.match(incident(t, id), /^status: converted$/m)
  assert.match(incident(t, id), /^control: \.claude\/rules\/routes\.md$/m)
  // 自分専用のルールには足さない
  assert.ok(!existsSync(personalRules(t)))
  // check は、control の指す先（リポジトリのファイル）があることを確かめる
  assert.deepEqual(note(t, ['check', '--json']).json?.errors ?? [], [])
})

test('promote --to team: 試用 Skill は、リポジトリへ移したことを確かめてから消す', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7 } } })
  startAuto(t, ['migration-forgotten'])
  draft(t, 'migration-forgotten')
  note(t, ['skill', 'add', '--session', 'auto-1', '--key', 'migration-forgotten', '--name', 'db-migration', '--description', 'demo-app でスキーマを変えるときに使う', '--body', '# 手順\n\n1. 生成する\n'], { now: at(63) })
  finishAuto(t)
  const dir = join(t.claudeHome, 'skills', 'demo-app-db-migration')
  const refused = promote(t, ['--key', 'migration-forgotten', '--to', 'team', '--path', '.claude/skills/db-migration/SKILL.md'], { now: at(0, 1) })
  assert.equal(refused.status, 1)
  assert.ok(existsSync(join(dir, 'SKILL.md')))
  writeFiles(t.repo, { '.claude/skills/db-migration/SKILL.md': '---\nname: db-migration\ndescription: スキーマを変えるときに使う\n---\n# 手順\n\n1. 生成する\n' })
  const run = promote(t, ['--key', 'migration-forgotten', '--to', 'team', '--path', '.claude/skills/db-migration/SKILL.md'], { now: at(1, 1) })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /試用Skill demo-app-db-migration を消しました/)
  assert.ok(!existsSync(dir))
  // 失敗票を起票していないので、下書きの扱いを案内する
  assert.match(run.stdout, /失敗票の下書きが残っています/)
  assert.deepEqual(note(t, ['review', '--json', '--session', 'human-1'], { now: at(2, 1) }).json.unreviewed, [])
})

test('promote は人だけの操作（自動改善のセッションと、その実行中は見送り）', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7 } } })
  humanTrial(t, 'route-placement', 'ルート定義は src/routes/ に置く')
  startAuto(t, ['flaky-e2e'])
  for (const s of ['auto-1', 'human-1']) {
    const run = note(t, ['promote', '--session', s, '--key', 'route-placement', '--to', 'personal'], { now: at(61) })
    assert.match(run.stdout, /^見送り：/, s)
  }
  finishAuto(t)
  assert.match(note(t, ['promote', '--session', 'auto-1', '--key', 'route-placement', '--to', 'personal'], { now: at(70) }).stdout, /^見送り：このセッションは、自動改善/)
  assert.deepEqual(trialKeys(t), ['route-placement'])
  assert.ok(!existsSync(personalRules(t)))
})
