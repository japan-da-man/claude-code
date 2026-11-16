import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { at, draft, finishAuto, humanTrial, makeEnv, note, repoId, script, startAuto, writeFiles } from './helpers.mjs'

const check = (t, args = ['--json'], cwd = t.repo) => {
  const run = spawnSync(process.execPath, [script('check.mjs'), cwd, ...args], { encoding: 'utf8', env: t.env, cwd })
  let json = null
  try {
    json = JSON.parse(run.stdout)
  } catch {
    // テキストの出力
  }
  return { status: run.status, stdout: run.stdout, json }
}
// user 側に失敗票を置く（harness-note incident add が書くものと同じ形）。
const incident = (t, id, fields) => writeFiles(join(t.user, 'incidents'), {
  [`${id}.md`]: `---\n${Object.entries({ id, repo: t.name, repo_id: repoId(t), cause_key: 'route-placement', status: 'open', control: 'null', ...fields }).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n## 何を頼んだか\n`,
})

test('整合がとれていれば、警告はない。見るのは、今のリポジトリの失敗票と、self-improve が足したルールだけ', () => {
  const t = makeEnv({
    files: {
      // リポジトリのファイル（チームのもの）は調べない。行数が多くても、失敗票 ID が書いてあっても、警告しない
      'CLAUDE.md': `${'- 行\n'.repeat(300)}- 導入前からある行（INC-2020-0001）\n`,
      '.claude/rules/routes.md': `${'- ルール\n'.repeat(80)}- ハンドラは 1 ファイル 1 ルート（INC-2020-0002）\n`,
    },
  })
  incident(t, 'INC-2026-0001', { status: 'converted', control: '.claude/rules/routes.md' })
  incident(t, 'INC-2026-0003', { status: 'wontfix' })
  incident(t, 'INC-2026-0004', { cause_key: 'migration-forgotten', status: 'trial', control: 'trial:rules/migration-forgotten' })
  // 別のリポジトリの失敗票は、おかしくても見ない
  writeFiles(join(t.user, 'incidents'), { 'INC-2026-0002.md': '---\nid: INC-2026-0002\nrepo: other-app\nrepo_id: other-app-000000000000\ncause_key: x\nstatus: trial\ncontrol: null\n---\n' })
  humanTrial(t, 'migration-forgotten', 'スキーマを変えたらマイグレーションを生成する', { ref: 'INC-2026-0004' })
  const run = check(t)
  assert.deepEqual(run.json.warnings, [])
  assert.equal(run.json.incidents, 3)
  assert.deepEqual(run.json.measure, { trial_rules: 1, personal_rules: 0, rule_lines: 1, rule_limit: 50 })
  assert.match(check(t, []).stdout, /self-improve が読み込ませるルール：1 行（試用ルール 1 行＋自分専用のルール 0 行、目安 50 行）。このリポジトリの失敗票 3 件。\n警告はありません/)
})

test('ルールが指す失敗票がない、status と control が食い違う、行数が目安を超える、ガードの定義がおかしい → 警告する（止めない）', () => {
  const t = makeEnv({
    config: { budget: { always_loaded_rule_lines: 2 } },
    files: { 'harness/guards.json': { disable_defaults: ['git-force-push'], rules: [{ id: 'bad', pattern: '(', message: 'x' }, { id: 'no-message', pattern: 'x' }] } },
    userFiles: { 'guards.json': { rules: [{ id: 'mine', path: '[', message: 'x' }] } },
  })
  incident(t, 'INC-2026-0001', { status: 'trial' })
  incident(t, 'INC-2026-0002', { status: 'open', control: '.claude/rules/always.md' })
  incident(t, 'INC-2026-0003', { status: 'converted', control: '.claude/rules/gone.md' })
  incident(t, 'INC-2026-0004', { status: 'done' })
  incident(t, 'INC-2026-0005', { status: 'trial', control: 'trial:rules/no-such-rule' })
  incident(t, 'INC-2026-0006', { status: 'converted', control: 'trial:rules/route-placement' })
  incident(t, 'INC-2026-0007', { status: 'converted', control: 'personal:~/.claude/skills/demo-app-gone' })
  humanTrial(t, 'route-placement', '試用ルール', { ref: 'INC-2026-0777' })
  writeFiles(join(t.user, 'repos/demo-app'), { 'rules.md': '# 自分専用\n\n- ルートは src/routes/ に置く（INC-2026-0404）\n- マイグレーションは手で書かない\n' })
  const run = check(t)
  assert.equal(run.status, 0)
  const messages = run.json.warnings.map((w) => `${w.rule}: ${w.message}`)
  const expect = [
    /^guards: ~\/\.claude\/self-improve\/guards\.json の mine：正規表現を読めません/,
    /^guards: harness\/guards\.json の bad：正規表現を読めません/,
    /^guards: harness\/guards\.json の no-message：id と message/,
    /^guards: harness\/guards\.json の disable_defaults は読みません（共通リストを外せるのは、user 側のファイルだけです）。~\/\.claude\/self-improve\/repos\/demo-app\/guards\.json に移してください/,
    /^incident_ref: 試用ルール route-placement が指す失敗票 INC-2026-0777 が、このリポジトリの失敗票にありません/,
    /^incident_ref: ~\/\.claude\/self-improve\/repos\/demo-app\/rules\.md:3 が指す失敗票 INC-2026-0404/,
    /^incident_control: INC-2026-0001：status が trial なのに、control（足した制御の場所）がありません/,
    /^incident_control: INC-2026-0002：status が open なのに、control（\.claude\/rules\/always\.md）が書かれています/,
    /^incident_control: INC-2026-0003：control（\.claude\/rules\/gone\.md）が見つかりません/,
    /^incident_status: INC-2026-0004：status（done）は/,
    /^incident_control: INC-2026-0005：control（trial:rules\/no-such-rule）が見つかりません/,
    /^incident_control: INC-2026-0006：status が converted なのに、control が試用/,
    /^incident_control: INC-2026-0007：control（personal:~\/\.claude\/skills\/demo-app-gone）が見つかりません/,
    /^budget: self-improve が読み込ませるルールが 3 行です（試用ルール 1 行＋自分専用のルール 2 行、目安 2 行）/,
  ]
  for (const re of expect) assert.ok(messages.some((m) => re.test(m)), `${re}\n${messages.join('\n')}`)
  assert.equal(messages.length, expect.length, messages.join('\n'))
  assert.match(check(t, []).stdout, /警告［incident_ref］/)
})

test('自分専用に昇格したルールと Skill を指す control は、見つかる', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7 } } })
  startAuto(t, ['route-placement', 'migration-forgotten'])
  draft(t, 'route-placement')
  note(t, ['trial', 'add', '--session', 'auto-1', '--key', 'route-placement', '--text', 'ルート定義は src/routes/ に置く'], { now: at(62) })
  draft(t, 'migration-forgotten')
  note(t, ['skill', 'add', '--session', 'auto-1', '--key', 'migration-forgotten', '--name', 'db-migration', '--description', 'demo-app でスキーマを変えるときに使う', '--body', '# 手順\n\n1. 生成する\n'], { now: at(63) })
  finishAuto(t)
  for (const key of ['route-placement', 'migration-forgotten']) {
    const id = /INC-\d{4}-\d{4}/.exec(note(t, ['incident', 'add', '--from-draft', '--key', key, '--session', 'human-1'], { now: at(0, 1) }).stdout)[0]
    assert.match(note(t, ['promote', '--key', key, '--to', 'personal', '--incident', id, '--session', 'human-1'], { now: at(1, 1) }).stdout, /自分専用へ昇格しました/)
  }
  const run = check(t)
  assert.deepEqual(run.json.warnings, [])
  assert.deepEqual(run.json.measure, { trial_rules: 0, personal_rules: 1, rule_lines: 1, rule_limit: 50 })
})

test('self-improve が動かない場所では、その旨を伝えて終わる。読めない設定は警告にする', () => {
  const none = makeEnv({ git: false })
  const run = check(none, [])
  assert.equal(run.status, 0)
  assert.match(run.stdout, /git リポジトリではありません/)
  const excluded = makeEnv({ config: { exclude: ['~/..'] } })
  assert.match(check(excluded, []).stdout, /exclude で、self-improve の対象から外してあります/)

  const broken = makeEnv({ files: { 'harness/config.json': '{ nope' }, userFiles: { 'repos/demo-app/config.json': '[1]' } })
  const messages = check(broken).json.warnings.map((w) => `${w.rule}: ${w.message}`)
  assert.ok(messages.some((m) => /^config: ~\/\.claude\/self-improve\/repos\/demo-app\/config\.json を読めません（.*）。このリポジトリの上書きは使っていません/.test(m)), messages.join('\n'))
  assert.ok(messages.some((m) => /^config: harness\/config\.json を読めません（.*）。検証コマンドは動いていません/.test(m)), messages.join('\n'))
})

test('読めないガードの定義は警告する（黙ってそのファイルのガードが外れないように）。4 か所のどれでも', () => {
  // 末尾にカンマがあるだけで、JSON としては読めない
  const brokenJson = '{"rules":[{"id":"no-psql","pattern":"\\\\bpsql\\\\b","message":"本番の DB に直接つながない"},]}'
  for (const [where, files, userFiles, label] of [
    ['repo', { 'harness/guards.json': brokenJson }, {}, 'harness\\/guards\\.json'],
    ['user', {}, { 'guards.json': brokenJson }, '~\\/\\.claude\\/self-improve\\/guards\\.json'],
    ['user-repo', {}, { 'repos/demo-app/guards.json': brokenJson }, '~\\/\\.claude\\/self-improve\\/repos\\/demo-app\\/guards\\.json'],
  ]) {
    const t = makeEnv({ files, userFiles })
    const run = check(t)
    assert.equal(run.status, 0)
    assert.deepEqual(run.json.warnings.map((w) => w.rule), ['guards_unreadable'], where)
    assert.match(run.json.warnings[0].message, new RegExp(`^${label} を読めません（.+）。このファイルのガードは、直すまで効きません$`))
    assert.doesNotMatch(check(t, []).stdout, /警告はありません/)
  }
  // 直せば消える
  const fixed = makeEnv({ files: { 'harness/guards.json': { rules: [{ id: 'no-psql', pattern: '\\bpsql\\b', message: '本番の DB に直接つながない' }] } } })
  assert.deepEqual(check(fixed).json.warnings, [])
})

test('人が user 側に足したガードや Skill を指す control（personal:~/…）は、そのファイルがあれば見つかる', () => {
  const t = makeEnv({ userFiles: { 'repos/demo-app/guards.json': { rules: [] } } })
  const add = (key, control) => note(t, ['incident', 'add', '--session', 'human-1', '--key', key, '--root-cause', 'forbidden', '--category', 'dev/mistake',
    '--asked', 'a', '--expected', 'b', '--actual', 'c', '--status', 'converted', '--control', control])
  assert.equal(add('generated-edit', 'personal:~/.claude/self-improve/repos/demo-app/guards.json').status, 0)
  assert.equal(add('missing-guard', 'personal:~/.claude/self-improve/repos/demo-app/missing.json').status, 0)
  assert.equal(add('outside-home', 'personal:/etc/hosts').status, 0)
  const run = spawnSync(process.execPath, [script('check.mjs'), t.repo, '--json'], { encoding: 'utf8', env: t.env })
  const messages = JSON.parse(run.stdout).warnings.map((w) => w.message)
  assert.equal(messages.length, 2, messages.join('\n'))
  assert.match(messages[0], /INC-2026-0002：control（personal:~\/\.claude\/self-improve\/repos\/demo-app\/missing\.json）が見つかりません/)
  assert.match(messages[1], /INC-2026-0003：control（personal:\/etc\/hosts）が見つかりません/)
})
