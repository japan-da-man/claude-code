import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NOTE, ROOT, SNEAKY_WRITES, at, decisionOf, draft, events, finishAuto, guardRun, knownSession, makeEnv, note, repoId, runHook, script, startAuto,
  writeFiles,
} from './helpers.mjs'

const pre = (t, tool, input, opts = {}, session = 'sess-1') => guardRun(t, session, tool, input, opts)
const bash = (t, command, opts, session) => pre(t, 'Bash', { command }, opts, session)
const decision = decisionOf
const AUTO = { auto: { interval_days: 7 } }

test('共通の禁止リスト：guards.default.test.json のテストケース（止める入力と、止めてはいけない入力）がすべて通る', () => {
  const cases = JSON.parse(readFileSync(join(ROOT, 'guards.default.test.json'), 'utf8'))
  const rules = JSON.parse(readFileSync(join(ROOT, 'guards.default.json'), 'utf8')).rules
  // どのルールにも、止める（または確認を挟む）側と、通す側の両方のテストがある
  assert.ok(cases.filter((c) => c.expect !== 'allow').length >= rules.length)
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

test('読み取りのずれで、禁止リストが隠れない（引用の中の <<EOF、区切りが単純でないヒアドキュメント、$\'…\'）', () => {
  const t = makeEnv()
  for (const command of [
    'echo "<<EOF"\ngit push --force origin main',
    'cat <<E-O-F\nx\nE-O-F\ngit push --force origin main',
    "echo $'\\'' ; git push --force origin main ; echo $'\\''",
    'cat <<EOF\nx\nEOF\ngit push -f',
  ]) {
    assert.equal(decision(bash(t, command)), 'deny', command)
  }
  // ヒアドキュメントの本文に書いてあるだけなら、止めない
  assert.equal(decision(bash(t, "cat > notes.md <<'EOF'\ngit push --force は使わない\nEOF")), 'allow')
})

test('test-guards: リポジトリ固有のガードとテストケースも実行し、期待と違えば終了コード 1', () => {
  const t = makeEnv({
    files: {
      'harness/guards.json': {
        rules: [
          { id: 'no-generated-edit', path: '^src/generated/', message: 'src/generated/ は手で編集しません。スキーマを直して pnpm gen を実行してください（INC-2026-0012）' },
          { id: 'no-prod-db', pattern: '\\bpsql\\b.*prod', message: '本番 DB には書き込みません。検証環境で確かめてください' },
          { id: 'ask-migrations', decision: 'ask', path: '^db/migrations/', message: 'マイグレーションは、内容を確かめてから書き換えます' },
        ],
      },
      'harness/guards.test.json': [
        { name: '生成物の手編集を止める', tool: 'Edit', input: { file_path: 'src/generated/api.ts' }, expect: 'deny' },
        { name: '生成物以外は通す', tool: 'Edit', input: { file_path: 'src/api.ts' }, expect: 'allow' },
        { name: '本番 DB への psql を止める', tool: 'Bash', input: { command: 'psql $PROD_URL -h prod-db -c "delete from users"' }, expect: 'deny' },
        { name: 'マイグレーションは確認を挟む', tool: 'Write', input: { file_path: 'db/migrations/001.sql' }, expect: 'ask' },
        { name: 'わざと外したテスト', tool: 'Bash', input: { command: 'psql -h localhost' }, expect: 'deny' },
      ],
    },
  })
  const run = spawnSync(process.execPath, [script('test-guards.mjs'), t.repo], { encoding: 'utf8', env: t.env })
  assert.equal(run.status, 1)
  assert.match(run.stdout, /OK {2}\[harness\/guards.test.json\] 生成物の手編集を止める/)
  assert.match(run.stdout, /OK {2}\[harness\/guards.test.json\] マイグレーションは確認を挟む/)
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
    // 大文字小文字を区別しないファイルシステムでは同じファイルなので、区別せずに比べる
    ['Edit', { file_path: join(t.repo, 'CLAUDE.MD') }],
    ['Write', { file_path: join(t.repo, 'Harness/Config.json') }],
    ['Write', { file_path: join(t.repo, '.Claude/Rules/routes.md') }],
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
    ['Bash', { command: 'chmod 644 harness/config.json' }],
    ['Read', { file_path: join(t.repo, 'harness/config.json') }],
  ]
  for (const [tool, input] of allows) assert.equal(decision(pre(t, tool, input)), 'allow', JSON.stringify(input))
  // 確認は信号ではないので、記録しない
  assert.deepEqual(events(t), [])
})

test('harness/guards.json：protect で確認を挟むパスを足し、disable_defaults で共通のルールを外せる', () => {
  const t = makeEnv({ files: { 'harness/guards.json': { protect: ['^infra/'], disable_defaults: ['git-no-verify'], rules: [{ id: 'broken', pattern: '(', message: 'x' }] } } })
  assert.equal(decision(pre(t, 'Write', { file_path: join(t.repo, 'infra/main.tf') })), 'ask')
  assert.equal(decision(bash(t, 'git commit --no-verify -m x')), 'allow')
  // 壊れたルールは読み飛ばし、ほかのルールは効く
  assert.equal(decision(bash(t, 'git push -f')), 'deny')
})

test('プラグイン自身のファイル、データ領域、試用 Skill への直接の書き込みは拒否する', () => {
  const t = makeEnv({ config: AUTO })
  assert.equal(decision(pre(t, 'Edit', { file_path: join(ROOT, 'guards.default.json') })), 'deny')
  assert.equal(decision(bash(t, `echo '{}' > ${join(ROOT, 'guards.default.json')}`)), 'deny')
  assert.equal(decision(pre(t, 'Write', { file_path: join(t.data, 'trial/x/rules/evil.json') })), 'deny')
  assert.equal(decision(bash(t, `rm -rf ${t.data}`)), 'deny')
  assert.match(pre(t, 'Write', { file_path: join(t.data, 'candidates/x.json') }).stderr, /harness-note コマンドだけが書き込みます/)

  startAuto(t, ['migration-forgotten'])
  draft(t, 'migration-forgotten', { extra: ['--root-cause', 'procedure'] })
  note(t, ['skill', 'add', '--session', 'auto-1', '--key', 'migration-forgotten', '--name', 'db', '--description', 'demo-app で使う', '--body', '手順'], { now: at(62) })
  finishAuto(t)
  const skill = join(t.claudeHome, 'skills/demo-app-db/SKILL.md')
  assert.ok(existsSync(skill))
  assert.equal(decision(pre(t, 'Edit', { file_path: skill })), 'deny')
  // 人が自分で置いた個人用の Skill は、このガードの対象外
  writeFiles(join(t.claudeHome, 'skills'), { 'mine/SKILL.md': 'x' })
  assert.equal(decision(pre(t, 'Edit', { file_path: join(t.claudeHome, 'skills/mine/SKILL.md') })), 'allow')
})

test('自動改善のセッション（ロック中）：通すのは Read・Grep・Glob・Skill と harness-note だけ。それ以外はすべて deny（確認は出さない）', () => {
  const t = makeEnv({ config: AUTO })
  note(t, ['lock', '--session', 'auto-1'], { now: at(0) })
  const opts = { now: at(5) }
  const denied = [
    ['Write', { file_path: join(t.repo, 'src/routes/user.ts'), content: 'x' }],
    ['Edit', { file_path: join(t.repo, 'README.md') }],
    ['NotebookEdit', { notebook_path: join(t.repo, 'a.ipynb') }],
    // ふだんは「確認」になるパスも、確認を出さずに拒否する（スケジュール済みタスクは確認で止まって待つため）
    ['Write', { file_path: join(t.repo, 'harness/config.json') }],
    ['Edit', { file_path: join(t.repo, '.claude/rules/routes.md') }],
    ['Write', { file_path: join(t.repo, '.env') }],
    // matcher を外したので、ほかのツールも見る。MCP のツール、サブエージェントの起動、スケジュールを作るツールも拒否する
    ['mcp__filesystem__write_file', { path: join(t.repo, 'x.txt'), content: 'x' }],
    ['mcp__github__create_pull_request', { title: 'auto' }],
    ['Agent', { prompt: '続きをやって' }],
    ['Task', { prompt: '続きをやって' }],
    ['CronCreate', { schedule: '* * * * *' }],
    ['WebFetch', { url: 'https://example.com' }],
    ['TodoWrite', { todos: [] }],
    // Bash は、harness-note の単純な呼び出しだけ。読むだけのコマンドも通さない（読むのは Read / Grep / Glob）
    ['Bash', { command: 'npm test' }],
    ['Bash', { command: 'cat CLAUDE.md && ls .claude/rules' }],
    ['Bash', { command: 'git log --oneline -5' }],
    ['Bash', { command: 'cd vendor/sub' }],
    ['Bash', { command: 'echo fix >> src/app.ts' }],
    ['Bash', { command: 'git commit -am "auto"' }],
    ['Bash', { command: 'harness-note keys --session auto-1 && npm run fix' }],
    ['Bash', { command: 'HARNESS_DATA_DIR=/tmp/elsewhere harness-note trial add --session auto-1 --key some-key --text x' }],
    ['Bash', { command: 'harness-note list --session auto-1 > candidates.txt' }],
    ['Bash', { command: 'harness-note add --session auto-1 --text "$(cat .env)"' }],
    ['Bash', { command: 'python3 -c "open(\'x\',\'w\').write(\'y\')"' }],
    ['Bash', { command: `${NOTE} status` }],
    ['Bash', { command: '' }],
  ]
  for (const [tool, input] of denied) {
    const run = pre(t, tool, input, opts, 'auto-1')
    assert.equal(run.status, 2, `${tool} ${JSON.stringify(input)}`)
    assert.equal(run.stdout, '', JSON.stringify(input))
    assert.match(run.stderr, /自動改善のセッションでは、Read・Grep・Glob・Skill と harness-note 以外のツールは使えません/)
  }
  // レビューで見つかった「読むだけに見えて書ける」コマンドは、どれも通さない
  for (const [name, command] of SNEAKY_WRITES) assert.equal(bash(t, command, opts, 'auto-1').status, 2, name)

  const passed = [
    ['Read', { file_path: join(t.repo, 'CLAUDE.md') }],
    ['Grep', { pattern: 'routes', path: t.repo }],
    ['Glob', { pattern: '.claude/rules/*.md' }],
    ['Skill', { skill: 'self-improve:auto-improve' }],
    ['Bash', { command: 'harness-note keys --session auto-1' }],
    ['Bash', { command: 'harness-note list --session=auto-1 --key route-placement' }],
    ['Bash', { command: 'harness-note trial add --session auto-1 --key route-placement --text "ルートは src/routes/ に置く"' }],
    ['Bash', { command: "harness-note trial add --session auto-1 --key cost-note --text '見積もりは $5 単位で書く'" }],
    ['Bash', { command: 'harness-note pending add --session auto-1 --key route-placement --root-cause knowledge \\\n  --asked "API を足す" --expected "src/routes/ に置く" --actual "src/api/ に置いた"' }],
    ['Bash', { command: "harness-note report write --session auto-1 --body - <<'EOF'\n## 検討の記録\n- route-placement: 候補 2 件 > 試用ルール; 既存のルールと矛盾なし $(x)\nEOF\nharness-note unlock --session auto-1" }],
    ['Bash', { command: `${NOTE} status --session auto-1` }],
  ]
  for (const [tool, input] of passed) assert.equal(decision(pre(t, tool, input, opts, 'auto-1')), 'allow', JSON.stringify(input))
  // 自動改善のセッションの拒否は、信号として記録しない
  assert.deepEqual(events(t), [])

  // ロックはセッション単位。同じ時間の人のセッションは、ふだんどおり
  assert.equal(decision(pre(t, 'Write', { file_path: join(t.repo, 'src/routes/user.ts') }, opts, 'human-1')), 'allow')
  assert.equal(decision(pre(t, 'Write', { file_path: join(t.repo, 'harness/config.json') }, opts, 'human-1')), 'ask')
  assert.equal(decision(bash(t, 'npm test', opts, 'human-1')), 'allow')
  assert.equal(decision(pre(t, 'mcp__github__create_pull_request', { title: 'x' }, opts, 'human-1')), 'allow')
})

test('ロック中の harness-note は、hook の session_id と一致する --session がちょうど 1 つ付いたものだけ通す', () => {
  const t = makeEnv({ config: AUTO })
  note(t, ['lock', '--session', 'auto-1'], { now: at(0) })
  const opts = { now: at(5) }
  const denied = [
    'harness-note keys',
    'harness-note trial add --key any-key --text "好きな 1 行" --session not-auto',
    'harness-note trial add --key any-key --text "好きな 1 行" --session=not-auto',
    'harness-note trial add --session auto-1 --key any-key --text x --session not-auto',
    'harness-note trial add --session auto-1 --session auto-1 --key any-key --text x',
    'harness-note mark --key route-placement --status rejected --session zzz',
    'harness-note trial add --key any-key --text x --session "$OTHER"',
    'harness-note trial add --key any-key --text x --session auto-1 $EXTRA',
    'harness-note trial add --key any-key --session auto-1 --text "${x@P}"',
    'harness-note trial add --key any-key --text x --session',
    'harness-note keys --session auto-1; harness-note keys',
  ]
  for (const command of denied) {
    const run = bash(t, command, opts, 'auto-1')
    assert.equal(run.status, 2, command)
    assert.equal(run.stdout, '')
  }
  // 理由と、付けるべき ID を返す
  assert.match(bash(t, 'harness-note keys', opts, 'auto-1').stderr, /--session auto-1 をちょうど 1 つ付けてください/)
  assert.match(bash(t, 'harness-note keys --session not-auto', opts, 'auto-1').stderr, /ほかのセッションを名乗ることはできません/)
  // --text の値として書いた "--session …" は、オプションではない
  assert.equal(decision(bash(t, 'harness-note trial add --session auto-1 --key any-key --text "--session not-auto"', opts, 'auto-1')), 'allow')
})

test('auto-improve のスキルに書いたコマンドは、そのままの形でロック中のガードを通る（セッション ID だけ置き換える）', () => {
  const t = makeEnv({ config: AUTO })
  startAuto(t, ['route-placement'])
  const skill = readFileSync(join(ROOT, 'skills/auto-improve/SKILL.md'), 'utf8')
  const blocks = [...skill.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1].trim())
  assert.ok(blocks.length >= 8)
  // 表の中に書いた 1 行のコマンドも確かめる
  const inline = [...skill.matchAll(/`(harness-note [^`\n]*--session[^`\n]*)`/g)].map((m) => m[1])
  assert.ok(inline.length >= 1)
  // スキルの置き換え（${CLAUDE_SESSION_ID}）と、モデルが埋める <…> の部分を、実際の値にする
  const fill = (command, id) => command.replaceAll('${CLAUDE_SESSION_ID}', id).replace(/(?<!<)<[^<>\n']+>/g, 'route-placement')
  for (const command of [...blocks, ...inline]) {
    assert.match(command, /^harness-note /)
    assert.equal(decision(bash(t, fill(command, 'auto-1'), {}, 'auto-1')), 'allow', command)
    // ID が埋め込まれなかったとき（変数のまま）と、ほかのセッションの ID は通らない
    assert.equal(decision(bash(t, command, {}, 'auto-1')), 'deny', command)
    assert.equal(decision(bash(t, fill(command, 'human-1'), {}, 'auto-1')), 'deny', command)
  }
})

test('ふだんのセッションでも、harness-note でほかのセッションを名乗ることはできない', () => {
  const t = makeEnv()
  assert.equal(decision(bash(t, 'harness-note keys')), 'allow')
  assert.equal(decision(bash(t, 'harness-note add --session sess-1 --category dev/mistake --key some-key --text "x"')), 'allow')
  assert.equal(decision(bash(t, 'git status && harness-note keys --session=sess-1')), 'allow')
  const denied = [
    'harness-note add --session fake-a --category dev/mistake --key planted-key --text "a"',
    'harness-note add --session=fake-b --category dev/mistake --key planted-key --text "b"',
    'harness-note add --session sess-1 --session fake-a --category dev/mistake --key planted-key --text "a"',
    'harness-note add --category dev/mistake --key planted-key --text a --session $SID',
    'harness-note add --category dev/mistake --key planted-key --text "$(cat x)"',
    'HARNESS_SESSION_ID=fake-a harness-note add --category dev/mistake --key planted-key --text a',
    'HARNESS_DATA_DIR=/tmp/x harness-note trial add --key some-key --text x',
    'git status && harness-note unlock --session someone-else',
    'bash -c "harness-note add --session fake-a --category dev/mistake --key planted-key --text a"',
  ]
  for (const command of denied) {
    const run = bash(t, command)
    assert.equal(run.status, 2, command)
    assert.match(run.stderr, /ルール：harness-note-call/)
  }
  assert.match(bash(t, 'harness-note keys --session fake-a').stderr, /このセッションは --session sess-1/)
})

test('ロックを試みたセッションは、ロックが外れたあと・始まらなかったあとも、書き込みに確認を挟む', () => {
  const t = makeEnv({ config: AUTO })
  startAuto(t, ['route-placement'])
  draft(t, 'route-placement')
  finishAuto(t)
  const opts = { now: at(70) }
  const asked = pre(t, 'Write', { file_path: join(t.repo, 'src/a.ts') }, opts, 'auto-1')
  assert.equal(decision(asked), 'ask')
  assert.match(asked.json.hookSpecificOutput.permissionDecisionReason, /自動改善（auto-improve）を呼び出したセッションです/)
  for (const [tool, input] of [['Bash', { command: 'npm test' }], ['Bash', { command: 'git commit -am x' }], ['mcp__github__create_pull_request', {}], ['Agent', { prompt: 'x' }]]) {
    assert.equal(decision(pre(t, tool, input, opts, 'auto-1')), 'ask', tool)
  }
  // 読むだけのもの、harness-note、禁止操作は、ふだんと同じ
  assert.equal(decision(pre(t, 'Read', { file_path: join(t.repo, 'a') }, opts, 'auto-1')), 'allow')
  assert.equal(decision(bash(t, 'git status', opts, 'auto-1')), 'allow')
  assert.equal(decision(bash(t, 'harness-note keys --session auto-1', opts, 'auto-1')), 'allow')
  assert.equal(decision(bash(t, 'git push --force', opts, 'auto-1')), 'deny')
  // ほかのセッションには関係ない
  assert.equal(decision(pre(t, 'Write', { file_path: join(t.repo, 'src/a.ts') }, opts, 'human-1')), 'allow')

  // ロックが始まらなかったセッション（間隔がたっていない）も同じ
  assert.match(note(t, ['lock', '--session', 'auto-2'], { now: at(80) }).stdout, /間隔がたっていません/)
  assert.equal(decision(pre(t, 'Write', { file_path: join(t.repo, 'src/a.ts') }, { now: at(81) }, 'auto-2')), 'ask')
  assert.equal(decision(bash(t, 'npm run build', { now: at(81) }, 'auto-2')), 'ask')

  // ロックが 2 時間で失効したあとも、そのセッションの書き込みは確認
  const t2 = makeEnv({ config: AUTO })
  note(t2, ['lock', '--session', 'auto-1'], { now: at(0) })
  assert.equal(bash(t2, 'npm test', { now: at(119) }, 'auto-1').status, 2)
  assert.equal(decision(bash(t2, 'npm test', { now: at(121) }, 'auto-1')), 'ask')
})

test('入れ子のリポジトリへ移っても、ロックと確認は外れない（リポジトリは CLAUDE_PROJECT_DIR を先に見る。ロックはセッション単位）', () => {
  const t = makeEnv({ config: AUTO })
  const sub = join(t.repo, 'vendor/sub')
  mkdirSync(join(sub, '.git'), { recursive: true })
  writeFiles(sub, { 'harness/config.json': {} })
  const fromSub = (session, tool, input, env = {}) => guardRun(t, session, tool, input, { now: at(5), env }, { cwd: sub })
  const project = { CLAUDE_PROJECT_DIR: t.repo }

  // 親のリポジトリで始めたセッションが、入れ子のリポジトリへ cd した場合：親の決まりで判定する
  assert.equal(decision(fromSub('human-1', 'Write', { file_path: join(t.repo, 'harness/config.json') }, project)), 'ask')
  assert.equal(decision(fromSub('human-1', 'Bash', { command: 'rm -rf ../../harness' }, project)), 'ask')
  assert.equal(decision(fromSub('human-1', 'Write', { file_path: join(t.repo, 'src/a.ts') }, project)), 'allow')

  // ロック中のセッションは、どこへ移ってもロック中（CLAUDE_PROJECT_DIR が渡らなくても、セッション ID で分かる）
  note(t, ['lock', '--session', 'auto-1'], { now: at(0) })
  for (const env of [project, {}]) {
    assert.equal(fromSub('auto-1', 'Write', { file_path: join(t.repo, 'src/a.ts') }, env).status, 2)
    assert.equal(fromSub('auto-1', 'Write', { file_path: join(sub, 'src/a.ts') }, env).status, 2)
    assert.equal(fromSub('auto-1', 'Bash', { command: 'rm -rf ../../src ../../harness' }, env).status, 2)
  }
  // 入れ子のリポジトリで harness-note を呼んでも、そのリポジトリには書き込めない
  const elsewhere = note(t, ['trial', 'add', '--session', 'auto-1', '--key', 'some-key', '--text', 'x'], { now: at(6), cwd: sub })
  assert.equal(elsewhere.status, 1)
  assert.match(elsewhere.stderr, /別のリポジトリで自動改善を実行中/)
})

test('読めない lock.json は、ロックなしではなく拒否の側に倒す', () => {
  const t = makeEnv({ config: AUTO })
  note(t, ['lock', '--session', 'auto-1'])
  const lockFile = join(t.data, 'state', repoId(t), 'lock.json')
  writeFileSync(lockFile, '{"session_id":"auto-1","at":"20')
  for (const session of ['auto-1', 'human-1']) {
    const run = pre(t, 'Write', { file_path: join(t.repo, 'src/a.ts') }, {}, session)
    assert.equal(run.status, 2, session)
    assert.match(run.stderr, /lock\.json）を読めません/)
    assert.equal(bash(t, 'npm test', {}, session).status, 2)
    assert.equal(decision(pre(t, 'Read', { file_path: join(t.repo, 'a') }, {}, session)), 'allow')
  }
  const refused = note(t, ['trial', 'add', '--session', 'human-1', '--key', 'some-key', '--text', 'x'])
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /lock\.json）を読めません/)
  assert.equal(note(t, ['status', '--json', '--session', 'human-1']).json.lock.broken, true)
})

test('harness/config.json がないリポジトリと HARNESS_DISABLE=1 では、どのツールにも何もしない', () => {
  const none = makeEnv({ initialized: false })
  for (const [tool, input] of [['Bash', { command: 'git push --force origin main' }], ['mcp__x__y', {}], ['Write', { file_path: join(none.repo, '.env') }]]) {
    const off = pre(none, tool, input)
    assert.deepEqual([off.status, off.stdout, off.stderr], [0, '', ''])
  }
  assert.equal(existsSync(none.data), false)

  const t = makeEnv()
  const disabled = bash(t, 'git push --force origin main', { env: { HARNESS_DISABLE: '1' } })
  assert.deepEqual([disabled.status, disabled.stdout, disabled.stderr], [0, '', ''])
  assert.deepEqual([pre(t, 'Write', { file_path: join(t.repo, 'harness/config.json') }, { env: { HARNESS_DISABLE: '1' } }).stdout], [''])
  assert.equal(existsSync(t.data), false)
  // 関係のないツールは、ふだんのセッションでは何も出さずに通す
  for (const tool of ['Read', 'Grep', 'TodoWrite', 'mcp__github__create_pull_request', 'Agent']) {
    const run = pre(t, tool, {})
    assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', ''], tool)
  }
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
  knownSession(t, 'x')
})
