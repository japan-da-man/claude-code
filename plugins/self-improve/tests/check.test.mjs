import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { at, makeEnv, note, script } from './helpers.mjs'

const check = (t, args = ['--json']) => {
  const run = spawnSync(process.execPath, [script('check.mjs'), t.repo, ...args], { encoding: 'utf8', env: t.env, cwd: t.repo })
  let json = null
  try {
    json = JSON.parse(run.stdout)
  } catch {
    // テキストの出力
  }
  return { status: run.status, stdout: run.stdout, json }
}
const incident = (fields) => `---\n${Object.entries({ id: 'INC-2026-0001', cause_key: 'route-placement', status: 'open', control: 'null', ...fields }).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n## 何を頼んだか\n`

test('整合がとれていれば、警告はない', () => {
  const t = makeEnv({
    files: {
      'CLAUDE.md': '# 地図\n\n- ルート定義は src/routes/ に置く（INC-2026-0001）\n- 導入前からある行（ID なし）\n',
      '.claude/rules/routes.md': '---\npaths:\n  - "src/routes/**"\n---\n- ハンドラは 1 ファイル 1 ルート（INC-2026-0002）\n',
      'harness/incidents/INC-2026-0001.md': incident({ status: 'converted', control: 'CLAUDE.md' }),
      'harness/incidents/INC-2026-0002.md': incident({ id: 'INC-2026-0002', status: 'converted', control: '.claude/rules/routes.md' }),
      'harness/incidents/INC-2026-0003.md': incident({ id: 'INC-2026-0003', status: 'wontfix' }),
      'harness/incidents/INC-2026-0004.md': incident({ id: 'INC-2026-0004', cause_key: 'migration-forgotten', status: 'trial', control: 'trial:rules/migration-forgotten' }),
    },
  })
  note(t, ['trial', 'add', '--session', 'h', '--key', 'migration-forgotten', '--text', 'スキーマを変えたらマイグレーションを生成する', '--ref', 'INC-2026-0004'], { now: at(0) })
  const run = check(t)
  assert.deepEqual(run.json.warnings, [])
  assert.equal(run.json.incidents, 4)
  const m = run.json.measure
  // CLAUDE.md と、常時ロードのルール（paths なしのルール＋試用ルール）は、別々の目安で数える
  assert.deepEqual([m.claude_md, m.claude_md_limit, m.unscoped_rules, m.trial_rules, m.rule_lines, m.rule_limit, m.total], [4, 100, 0, 1, 1, 50, 5])
  assert.match(check(t, []).stdout, /警告はありません/)
})

test('ルール行が指す失敗票がない、status と control が食い違う、行数が目安を超える → 警告する（止めない）', () => {
  const t = makeEnv({
    config: { budget: { claude_md_lines: 5, always_loaded_rule_lines: 3, scoped_rule_file_lines: 2 } },
    files: {
      'CLAUDE.md': `${'- 行\n'.repeat(6)}- 存在しない票を指す行（INC-2026-0404）\n`,
      '.claude/rules/always.md': '- a（INC-2026-0001）\n- b\n- c\n- d（INC-2025-0009）\n',
      '.claude/rules/scoped.md': '---\npaths: ["src/**"]\n---\n- x\n- y\n',
      'harness/incidents/INC-2026-0001.md': incident({ status: 'trial' }),
      'harness/incidents/INC-2026-0002.md': incident({ id: 'INC-2026-0002', status: 'open', control: '.claude/rules/always.md' }),
      'harness/incidents/INC-2026-0003.md': incident({ id: 'INC-2026-0003', status: 'converted', control: '.claude/rules/gone.md' }),
      'harness/incidents/INC-2026-0004.md': incident({ id: 'INC-2026-0004', status: 'done' }),
      'harness/incidents/INC-2026-0005.md': incident({ id: 'INC-2026-0005', status: 'trial', control: 'trial:rules/no-such-rule' }),
      'harness/incidents/INC-2026-0006.md': incident({ id: 'INC-2026-0006', status: 'converted', control: 'trial:rules/route-placement' }),
      'harness/incidents/README.md': '失敗票の置き場所',
      'harness/guards.json': { rules: [{ id: 'bad', pattern: '(', message: 'x' }, { id: 'no-message', pattern: 'x' }] },
    },
  })
  note(t, ['trial', 'add', '--session', 'h', '--key', 'route-placement', '--text', '試用ルール（INC-2026-0777）'], { now: at(0) })
  const run = check(t)
  assert.equal(run.status, 0)
  const messages = run.json.warnings.map((w) => `${w.rule}: ${w.message}`)
  const expect = [
    /^incident_ref: CLAUDE\.md:7 が指す失敗票 INC-2026-0404/,
    /^incident_ref: \.claude\/rules\/always\.md:4 が指す失敗票 INC-2025-0009/,
    /^incident_ref: 試用ルール route-placement:1 が指す失敗票 INC-2026-0777/,
    /^incident_control: INC-2026-0001：status が trial なのに、control（足した制御のパス）がありません/,
    /^incident_control: INC-2026-0002：status が open なのに、control（\.claude\/rules\/always\.md）が書かれています/,
    /^incident_control: INC-2026-0003：control（\.claude\/rules\/gone\.md）が見つかりません/,
    /^incident_status: INC-2026-0004：status（done）は/,
    /^incident_control: INC-2026-0005：control（trial:rules\/no-such-rule）が見つかりません/,
    /^incident_control: INC-2026-0006：status が converted なのに、control が試用/,
    /^budget: CLAUDE\.md が 7 行です（目安 5 行）/,
    /^budget: 常時ロードのルールが 5 行です（paths なしのルール 4 行＋試用ルール 1 行、目安 3 行）/,
    /^budget: \.claude\/rules\/scoped\.md が 5 行です（目安 2 行）/,
    /^guards: harness\/guards\.json の bad：正規表現を読めません/,
    /^guards: harness\/guards\.json の no-message：id と message/,
  ]
  for (const re of expect) assert.ok(messages.some((m) => re.test(m)), `${re}\n${messages.join('\n')}`)
  assert.equal(messages.length, expect.length, messages.join('\n'))
  // 実在する票を指す行は、警告しない
  assert.ok(!messages.some((m) => m.includes('always.md:1')))
  const text = check(t, [])
  assert.equal(text.status, 0)
  assert.match(text.stdout, /警告［budget］CLAUDE\.md が 7 行です/)
})

test('init していないリポジトリでは、その旨を伝えて終わる。壊れた config.json は警告にする', () => {
  const none = makeEnv({ initialized: false })
  const run = check(none, [])
  assert.equal(run.status, 0)
  assert.match(run.stdout, /self-improve:init/)
  const broken = makeEnv({ files: { 'harness/config.json': '{ nope' } })
  assert.match(check(broken).json.warnings[0].message, /harness\/config\.json を読めません/)
})

test('読めない harness/guards.json は警告する（黙ってリポジトリ固有のガードが外れないように）', () => {
  // 末尾にカンマがあるだけで、JSON としては読めない
  const t = makeEnv({ files: { 'harness/guards.json': '{"rules":[{"id":"no-psql","pattern":"\\\\bpsql\\\\b","message":"本番の DB に直接つながない"},]}' } })
  const run = check(t)
  assert.equal(run.status, 0)
  assert.deepEqual(run.json.warnings.map((w) => w.rule), ['guards_unreadable'])
  assert.match(run.json.warnings[0].message, /^harness\/guards\.json を読めません（.+）。このリポジトリのガードは、直すまで効きません$/)
  assert.match(check(t, []).stdout, /harness\/guards\.json を読めません/)
  assert.doesNotMatch(check(t, []).stdout, /警告はありません/)
  // 直せば消える
  const fixed = makeEnv({ files: { 'harness/guards.json': { rules: [{ id: 'no-psql', pattern: '\\bpsql\\b', message: '本番の DB に直接つながない' }] } } })
  assert.deepEqual(check(fixed).json.warnings, [])
})
