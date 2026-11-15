import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NOTE, ROOT, at, events, makeEnv, note, runHook, script, startAuto, writeFiles } from './helpers.mjs'

const pre = (t, tool, input, opts = {}, session = 'sess-1') =>
  runHook('guard-harness.mjs', { session_id: session, prompt_id: 'p1', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }, t, opts)
const bash = (t, command, opts, session) => pre(t, 'Bash', { command }, opts, session)
const decision = (run) => (run.status === 2 ? 'deny' : run.json?.hookSpecificOutput?.permissionDecision ?? 'allow')

test('共通の禁止リスト：guards.default.test.json のテストケース（止める入力と、止めてはいけない入力）がすべて通る', () => {
  const cases = JSON.parse(readFileSync(join(ROOT, 'guards.default.test.json'), 'utf8'))
  const rules = JSON.parse(readFileSync(join(ROOT, 'guards.default.json'), 'utf8')).rules
  // どのルールにも、止める側と通す側の両方のテストがある
  assert.ok(cases.filter((c) => c.expect === 'deny').length >= rules.length)
  assert.ok(cases.filter((c) => c.expect === 'allow').length >= rules.length)
  for (const rule of rules) assert.ok(rule.id && rule.message && (rule.pattern || rule.path), rule.id)

  const t = makeEnv()
  const run = spawnSync(process.execPath, [script('test-guards.mjs'), t.repo, '--json'], { encoding: 'utf8', env: t.env })
  const result = JSON.parse(run.stdout)
  assert.deepEqual(result.results.filter((r) => !r.ok), [])
  assert.equal(result.results.length, cases.length)
  assert.equal(run.status, 0)
  // テストの実行では、拒否を生ログに残さない
  assert.deepEqual(events(t), [])
})

test('test-guards: リポジトリ固有のガードとテストケースも実行し、期待と違えば終了コード 1', () => {
  const t = makeEnv({
    files: {
      'harness/guards.json': {
        rules: [
          { id: 'no-generated-edit', path: '^src/generated/', message: 'src/generated/ は手で編集しません。スキーマを直して pnpm gen を実行してください（INC-2026-0012）' },
          { id: 'no-prod-db', pattern: '\\bpsql\\b.*prod', message: '本番 DB には書き込みません。検証環境で確かめてください' },
        ],
      },
      'harness/guards.test.json': [
        { name: '生成物の手編集を止める', tool: 'Edit', input: { file_path: 'src/generated/api.ts' }, expect: 'deny' },
        { name: '生成物以外は通す', tool: 'Edit', input: { file_path: 'src/api.ts' }, expect: 'allow' },
        { name: '本番 DB への psql を止める', tool: 'Bash', input: { command: 'psql $PROD_URL -h prod-db -c "delete from users"' }, expect: 'deny' },
        { name: 'わざと外したテスト', tool: 'Bash', input: { command: 'psql -h localhost' }, expect: 'deny' },
      ],
    },
  })
  const run = spawnSync(process.execPath, [script('test-guards.mjs'), t.repo], { encoding: 'utf8', env: t.env })
  assert.equal(run.status, 1)
  assert.match(run.stdout, /OK {2}\[harness\/guards.test.json\] 生成物の手編集を止める/)
  assert.match(run.stdout, /NG {2}\[harness\/guards.test.json\] わざと外したテスト（期待 deny、実際 allow/)
  // エラー文には直し方を書く
  const denied = pre(t, 'Edit', { file_path: join(t.repo, 'src/generated/api.ts') })
  assert.equal(denied.status, 2)
  assert.match(denied.stderr, /スキーマを直して pnpm gen を実行してください（INC-2026-0012）（ルール：no-generated-edit）/)
})

test('拒否は終了コード 2 で理由と直し方を返し、自分で生ログに記録する', () => {
  const t = makeEnv()
  const run = bash(t, 'git push --force origin main')
  assert.equal(run.status, 2)
  assert.match(run.stderr, /\[self-improve\] git push --force.*--force-with-lease.*（ルール：git-force-push）/)
  assert.equal(run.stdout, '')
  const logged = events(t)
  assert.equal(logged.length, 1)
  assert.deepEqual([logged[0].type, logged[0].rule, logged[0].tool, logged[0].session_id, logged[0].prompt_id], ['guard_denied', 'git-force-push', 'Bash', 'sess-1', 'p1'])
  assert.equal(decision(bash(t, 'git push origin main')), 'allow')
  assert.equal(events(t).length, 1)
})

test('ハーネスのファイルへの書き込みには permissionDecision: "ask" を返す（Bash で触るコマンドも同じ）', () => {
  const t = makeEnv()
  const run = pre(t, 'Write', { file_path: join(t.repo, 'harness/guards.json'), content: '{}' })
  assert.equal(run.status, 0)
  assert.deepEqual(Object.keys(run.json.hookSpecificOutput).sort(), ['hookEventName', 'permissionDecision', 'permissionDecisionReason'])
  assert.equal(run.json.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(run.json.hookSpecificOutput.permissionDecision, 'ask')
  assert.match(run.json.hookSpecificOutput.permissionDecisionReason, /harness\/guards\.json/)

  const asks = [
    ['Write', { file_path: join(t.repo, 'harness/config.json') }],
    ['Edit', { file_path: join(t.repo, 'harness/guards.test.json') }],
    ['Edit', { file_path: join(t.repo, '.claude/rules/routes.md') }],
    ['Write', { file_path: join(t.repo, '.claude/skills/db/SKILL.md') }],
    ['Edit', { file_path: join(t.repo, 'CLAUDE.md') }],
    ['Edit', { file_path: join(t.repo, 'apps/api/CLAUDE.md') }],
    ['Write', { file_path: join(t.repo, 'biome.json') }],
    ['NotebookEdit', { notebook_path: join(t.repo, '.claude/rules/x.md') }],
    ['Bash', { command: 'mv harness/guards.json harness/guards.bak' }],
    ['Bash', { command: 'rm -rf .claude/rules' }],
    ['Bash', { command: 'cd harness && sed -i s/5/50/ ../harness/config.json' }],
    ['Bash', { command: 'git checkout -- CLAUDE.md' }],
    ['Bash', { command: "cat > harness/config.json <<'EOF'\n{}\nEOF" }],
  ]
  for (const [tool, input] of asks) assert.equal(decision(pre(t, tool, input)), 'ask', JSON.stringify(input))

  const allows = [
    ['Write', { file_path: join(t.repo, 'harness/incidents/INC-2026-0001.md') }],
    ['Write', { file_path: join(t.repo, 'harness/reports/prune-2026-11.md') }],
    ['Edit', { file_path: join(t.repo, 'src/CLAUDE.md.ts') }],
    ['Edit', { file_path: join(t.base, 'elsewhere/CLAUDE.md') }],
    ['Bash', { command: 'cat harness/config.json CLAUDE.md' }],
    ['Bash', { command: 'git add harness/ .claude/rules && git commit -m "harness(INC-2026-0001): x"' }],
    ['Bash', { command: 'node scripts/build.js harness/config.json' }],
    ['Read', { file_path: join(t.repo, 'harness/config.json') }],
  ]
  for (const [tool, input] of allows) assert.equal(decision(pre(t, tool, input)), 'allow', JSON.stringify(input))
  // 確認は信号ではないので、記録しない
  assert.deepEqual(events(t), [])
})

test('harness/guards.json：protect で確認を挟むパスを足し、disable_defaults で共通のルールを外せる', () => {
  const t = makeEnv({ files: { 'harness/guards.json': { protect: ['^infra/'], disable_defaults: ['git-no-verify'], rules: [{ id: 'broken', pattern: '(' , message: 'x' }] } } })
  assert.equal(decision(pre(t, 'Write', { file_path: join(t.repo, 'infra/main.tf') })), 'ask')
  assert.equal(decision(bash(t, 'git commit --no-verify -m x')), 'allow')
  // 壊れたルールは読み飛ばし、ほかのルールは効く
  assert.equal(decision(bash(t, 'git push -f')), 'deny')
})

test('プラグイン自身のファイル、データ領域、試用 Skill への直接の書き込みは拒否する', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7 } } })
  assert.equal(decision(pre(t, 'Edit', { file_path: join(ROOT, 'guards.default.json') })), 'deny')
  assert.equal(decision(bash(t, `echo '{}' > ${join(ROOT, 'guards.default.json')}`)), 'deny')
  assert.equal(decision(pre(t, 'Write', { file_path: join(t.data, 'trial/x/rules/evil.json') })), 'deny')
  assert.equal(decision(bash(t, `rm -rf ${t.data}`)), 'deny')
  assert.match(pre(t, 'Write', { file_path: join(t.data, 'candidates/x.json') }).stderr, /harness-note コマンドだけが書き込みます/)

  startAuto(t, ['migration-forgotten'])
  note(t, ['pending', 'add', '--session', 'auto-1', '--key', 'migration-forgotten', '--root-cause', 'procedure', '--asked', 'a', '--expected', 'b', '--actual', 'c'], { now: at(61) })
  note(t, ['skill', 'add', '--session', 'auto-1', '--key', 'migration-forgotten', '--name', 'db', '--description', 'demo-app で使う', '--body', '手順'], { now: at(62) })
  note(t, ['unlock', '--session', 'auto-1'])
  const skill = join(t.claudeHome, 'skills/demo-app-db/SKILL.md')
  assert.ok(existsSync(skill))
  assert.equal(decision(pre(t, 'Edit', { file_path: skill })), 'deny')
  // 人が自分で置いた個人用の Skill は、このガードの対象外
  writeFiles(join(t.claudeHome, 'skills'), { 'mine/SKILL.md': 'x' })
  assert.equal(decision(pre(t, 'Edit', { file_path: join(t.claudeHome, 'skills/mine/SKILL.md') })), 'allow')
})

test('自動改善のセッション：書き込みはすべて deny（確認は出さない）。通すのは harness-note と読むだけのコマンド', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7 } } })
  note(t, ['lock', '--session', 'auto-1'], { now: at(0) })
  const opts = { now: at(5) }
  const denied = [
    ['Write', { file_path: join(t.repo, 'src/routes/user.ts'), content: 'x' }],
    ['Edit', { file_path: join(t.repo, 'README.md') }],
    ['NotebookEdit', { notebook_path: join(t.repo, 'a.ipynb') }],
    // ふだんは「確認」になるパスも、確認を出さずに拒否する（スケジュール済みタスクは確認で止まって待つため）
    ['Write', { file_path: join(t.repo, 'harness/config.json') }],
    ['Edit', { file_path: join(t.repo, '.claude/rules/routes.md') }],
    ['Bash', { command: 'npm test' }],
    ['Bash', { command: 'echo fix >> src/app.ts' }],
    ['Bash', { command: 'git commit -am "auto"' }],
    ['Bash', { command: 'harness-note keys && npm run fix' }],
    ['Bash', { command: 'HARNESS_DATA_DIR=/tmp/elsewhere harness-note trial add --key some-key --text x' }],
    ['Bash', { command: 'harness-note list > candidates.txt' }],
    ['Bash', { command: 'harness-note add --text "$(cat .env)"' }],
    ['Bash', { command: 'python3 -c "open(\'x\',\'w\').write(\'y\')"' }],
  ]
  for (const [tool, input] of denied) {
    const run = pre(t, tool, input, opts, 'auto-1')
    assert.equal(run.status, 2, JSON.stringify(input))
    assert.equal(run.stdout, '', JSON.stringify(input))
    assert.match(run.stderr, /自動改善のセッションでは、ファイルへの書き込みはすべて拒否します|ルール：/)
  }
  const passed = [
    'harness-note keys',
    'harness-note trial add --key route-placement --text "ルートは src/routes/ に置く"',
    "harness-note report write --body - <<'EOF'\n## 検討の記録\n- route-placement: 候補 2 件 > 試用ルール; 既存のルールと矛盾なし\nEOF",
    'harness-note pending add --key route-placement --root-cause knowledge \\\n  --asked "API を足す" --expected "src/routes/ に置く" --actual "src/api/ に置いた"',
    "harness-note report write --body - <<'EOF'\n本文\nEOF\nharness-note unlock --session auto-1",
    `${NOTE} status`,
    'cat CLAUDE.md && ls .claude/rules',
    'git log --oneline -5',
    'grep -rn "routes" src | head -20',
  ]
  for (const command of passed) assert.equal(decision(bash(t, command, opts, 'auto-1')), 'allow', command)
  // 自動改善のセッションの拒否は、信号として記録しない
  assert.deepEqual(events(t), [])

  // ロックはセッション単位。同じ時間の人のセッションは、ふだんどおり
  assert.equal(decision(pre(t, 'Write', { file_path: join(t.repo, 'src/routes/user.ts') }, opts, 'human-1')), 'allow')
  assert.equal(decision(pre(t, 'Write', { file_path: join(t.repo, 'harness/config.json') }, opts, 'human-1')), 'ask')
  assert.equal(decision(bash(t, 'npm test', opts, 'human-1')), 'allow')
  // unlock のあとと、2 時間たったあとは、ふだんどおりに戻る
  assert.equal(decision(bash(t, 'npm test', { now: at(121) }, 'auto-1')), 'allow')
  note(t, ['unlock', '--session', 'auto-1'], { now: at(10) })
  assert.equal(decision(bash(t, 'npm test', { now: at(11) }, 'auto-1')), 'allow')
})

test('harness/config.json がないリポジトリと HARNESS_DISABLE=1 では、何もしない', () => {
  const none = makeEnv({ initialized: false })
  const off = bash(none, 'git push --force origin main')
  assert.deepEqual([off.status, off.stdout, off.stderr], [0, '', ''])
  assert.equal(existsSync(none.data), false)

  const t = makeEnv()
  const disabled = bash(t, 'git push --force origin main', { env: { HARNESS_DISABLE: '1' } })
  assert.deepEqual([disabled.status, disabled.stdout, disabled.stderr], [0, '', ''])
  assert.deepEqual([pre(t, 'Write', { file_path: join(t.repo, 'harness/config.json') }, { env: { HARNESS_DISABLE: '1' } }).stdout], [''])
  assert.equal(existsSync(t.data), false)
  // git リポジトリの外でも何もしない
  const outside = runHook('guard-harness.mjs', { session_id: 's', cwd: none.base, tool_name: 'Bash', tool_input: { command: 'git push -f' } }, none)
  assert.equal(outside.status, 0)
})

test('壊れた入力でも、作業は止めない', () => {
  const t = makeEnv()
  const run = spawnSync(process.execPath, [script('guard-harness.mjs')], { input: 'not json', encoding: 'utf8', cwd: t.repo, env: t.env })
  assert.equal(run.status, 0)
  assert.equal(decision(pre(t, 'Bash', {})), 'allow')
  assert.equal(decision(pre(t, 'Write', {})), 'allow')
})
