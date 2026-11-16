import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
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

test('共通の禁止リスト：誤検知と取りこぼしを直した入力（.env は確認、rm -r は引数のどれか、commit の -nm）', () => {
  const t = makeEnv()
  const expectations = [
    // .env：拒否ではなく確認。対象は .env と .env.<環境名> だけ
    ['cp .env.example .env', 'ask'], ['echo NEXT_PUBLIC_X=1 >> .env.local', 'ask'], ['touch .env.test', 'ask'],
    ['chmod 600 .env', 'allow'], ['rm .env.bak', 'allow'], ['cat .env', 'allow'],
    // rm -r：ルートやホームが最初の引数でなくても止める
    ['rm -rf build ~', 'deny'], ['rm -rf node_modules $HOME/', 'deny'], ['rm -rf build dist', 'allow'],
    // --no-verify：まとめた短いオプションも止める。メッセージの中身は見ない
    ['git commit -nm msg', 'deny'], ['git commit -anm msg', 'deny'], ['git commit -m "-n"', 'allow'], ['git commit -am "fix"', 'allow'],
  ]
  for (const [command, expected] of expectations) assert.equal(decision(bash(t, command)), expected, command)
  assert.equal(decision(pre(t, 'Write', { file_path: join(t.repo, 'config/.env.test') })), 'ask')
  assert.equal(decision(pre(t, 'Write', { file_path: join(t.repo, 'docs/.env.md') })), 'allow')
  assert.equal(decision(pre(t, 'Write', { file_path: join(t.repo, '.env.example') })), 'allow')
  assert.match(pre(t, 'Write', { file_path: join(t.repo, '.env') }).json.hookSpecificOutput.permissionDecisionReason, /\.env は秘密の値を持つファイルです.*ルール：env-file-write/)
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

test('シンボリックリンクで保護を外せない：書き込み先は、リンクの名前と実体の両方で判定する', () => {
  const t = makeEnv({ files: { 'AGENTS.md': '# 地図\n', 'harness/guards.json': { rules: [{ id: 'no-generated-edit', path: '^src/generated/', message: '生成し直してください' }] } } })
  // CLAUDE.md -> AGENTS.md：リンクの名前への書き込みも、実体への書き込みも、CLAUDE.md への書き込みとして確認を挟む
  symlinkSync('AGENTS.md', join(t.repo, 'CLAUDE.md'))
  for (const [tool, input] of [
    ['Write', { file_path: join(t.repo, 'CLAUDE.md') }],
    ['Edit', { file_path: join(t.repo, 'AGENTS.md') }],
    ['Bash', { command: 'echo "- 新しい行" >> CLAUDE.md' }],
    ['Bash', { command: 'sed -i s/a/b/ AGENTS.md' }],
  ]) {
    const run = pre(t, tool, input)
    assert.equal(decision(run), 'ask', JSON.stringify(input))
    assert.match(run.json.hookSpecificOutput.permissionDecisionReason, /CLAUDE\.md（(CLAUDE|AGENTS)\.md）への書き込み/)
  }
  // リンクでなければ、AGENTS.md はふつうのファイル
  const plain = makeEnv({ files: { 'AGENTS.md': '# 地図\n', 'CLAUDE.md': '# 地図\n' } })
  assert.equal(decision(pre(plain, 'Edit', { file_path: join(plain.repo, 'AGENTS.md') })), 'allow')

  // リポジトリの外を指すディレクトリのリンク：名前のパスにルールが当たる。ログには、リポジトリからの相対パスを残す（絶対パスを残さない）
  const outside = join(t.base, 'outside')
  mkdirSync(outside)
  mkdirSync(join(t.repo, 'src'))
  symlinkSync(outside, join(t.repo, 'src/generated'))
  const viaLink = pre(t, 'Write', { file_path: join(t.repo, 'src/generated/api.ts') })
  assert.equal(viaLink.status, 2)
  assert.match(viaLink.stderr, /生成し直してください/)
  assert.equal(events(t).at(-1).target, 'src/generated/api.ts')
  // リポジトリの外から、リンクの実体を指して書いても同じ（実体の側で、同じ保護に当たる）
  symlinkSync(join(t.repo, 'harness'), join(t.base, 'elsewhere'))
  assert.equal(decision(pre(t, 'Write', { file_path: join(t.base, 'elsewhere/config.json') })), 'ask')
  assert.equal(decision(bash(t, `echo x > ${join(t.base, 'elsewhere/guards.json')}`)), 'ask')

  // 個人用の Skill の置き場所がリンク（dotfiles で管理）のとき：実体のパスを直接指しても、試用 Skill は書き換えられない
  const linked = makeEnv({ config: AUTO })
  const real = join(linked.base, 'dotfiles/skills')
  mkdirSync(real, { recursive: true })
  symlinkSync(real, join(linked.claudeHome, 'skills'))
  startAuto(linked, ['migration-forgotten'])
  draft(linked, 'migration-forgotten')
  const added = note(linked, ['skill', 'add', '--session', 'auto-1', '--key', 'migration-forgotten', '--name', 'db-migration', '--description', 'demo-app リポジトリで DB のスキーマを変えるときに使う', '--body', '# 手順\n\n1. マイグレーションを生成する\n'], { now: at(62) })
  assert.equal(added.status, 0, added.stderr)
  finishAuto(linked)
  for (const file of [join(real, 'demo-app-db-migration/SKILL.md'), join(linked.claudeHome, 'skills/demo-app-db-migration/SKILL.md')]) {
    const run = pre(linked, 'Write', { file_path: file }, {}, 'human-1')
    assert.equal(run.status, 2, file)
    assert.match(run.stderr, /ルール：trial-skill/)
  }
  // リポジトリの中に置いたリンク経由でも同じ
  symlinkSync(join(real, 'demo-app-db-migration'), join(linked.repo, 'skill-link'))
  assert.equal(pre(linked, 'Edit', { file_path: join(linked.repo, 'skill-link/SKILL.md') }, {}, 'human-1').status, 2)
  assert.equal(bash(linked, 'rm -rf skill-link/', {}, 'human-1').status, 2)
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

test('自動改善のセッション（ロック中）：通すのは Read・Grep・Glob と harness-note だけ（Skill は auto-improve の読み直しだけ）。それ以外はすべて deny（確認は出さない）', () => {
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
    // Skill は、本文の !`cmd` や context: fork で、PreToolUse の外でコマンドやサブエージェントを動かしうる。読み直し用の 1 つだけ通す
    ['Skill', { skill: 'some-plugin:deploy', args: 'production' }],
    ['Skill', { skill: 'self-improve:review' }],
    ['Skill', { skill: 'auto-improve' }],
    ['Skill', {}],
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
    // ヒアストリングやリダイレクト先の語の展開も見る（環境変数の値を、記録に写せないように）
    ['Bash', { command: 'harness-note report write --session auto-1 --body - <<< "$HOME"' }],
    ['Bash', { command: 'harness-note report write --session auto-1 --body - <<< $ANTHROPIC_API_KEY' }],
    ['Bash', { command: 'harness-note keys --session auto-1 2> /dev/null <<< ~' }],
    // 引用の外の { } * ? [ ] ~ は、bash が語を作り替える。{--session=zz,--key} は 2 語になり、後ろの --key が本物の --session を値として飲み込む
    ['Bash', { command: 'harness-note mark {--session=zz,--key} --session auto-1 --key route-placement --status rejected' }],
    ['Bash', { command: 'harness-note trial add {--session=zz,--key} --session auto-1 --key free-key --text x' }],
    ['Bash', { command: 'harness-note trial add --session auto-1 --key some-key --text x{a,b}' }],
    ['Bash', { command: 'harness-note pending show --session auto-1 *' }],
    ['Bash', { command: 'harness-note pending show --session auto-1 route-?lacement' }],
    ['Bash', { command: 'harness-note pending show --session auto-1 [r]oute-placement' }],
    ['Bash', { command: 'harness-note skill add --session auto-1 --key some-key --name x --description d --file ~/notes.md' }],
    // ほかのコマンドで包んだ呼び出し
    ['Bash', { command: 'command harness-note keys --session auto-1' }],
    ['Bash', { command: 'env harness-note keys --session auto-1' }],
    ['Bash', { command: `node ${join(ROOT, 'scripts/note.mjs')} keys --session auto-1` }],
    ['Bash', { command: './harness-note keys --session auto-1' }],
  ]
  for (const [tool, input] of denied) {
    const run = pre(t, tool, input, opts, 'auto-1')
    assert.equal(run.status, 2, `${tool} ${JSON.stringify(input)}`)
    assert.equal(run.stdout, '', JSON.stringify(input))
    assert.match(run.stderr, /自動改善のセッションでは、Read・Grep・Glob と harness-note 以外のツールは使えません/)
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
    // 引用の中なら、{ } * ? [ ] ~ はそのままの文字
    ['Bash', { command: "harness-note trial add --session auto-1 --key glob-note --text 'テストは src/**/*.test.ts に置く（{unit,e2e} は分ける）'" }],
    ['Bash', { command: 'harness-note trial add --session auto-1 --key home-note --text "設定は ~/.config ではなく [app] の下に置く"' }],
    ['Bash', { command: "harness-note report write --session auto-1 --body - <<< '検討の記録 $HOME は展開されない'" }],
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

test('中-A の再現：ブレース展開で --session の照合を外した呼び出しは、ガードが断り、harness-note も人だけの操作を見送る', () => {
  const t = makeEnv({ config: AUTO })
  startAuto(t, ['route-placement'])
  const tricks = [
    'harness-note mark {--session=zz,--key} --session auto-1 --key route-placement --status rejected',
    "harness-note trial add {--session=zz,--key} --session auto-1 --key free-key --text '対象外の 1 行'",
    'harness-note trial remove {--session=zz,--key} --session auto-1 --key route-placement',
  ]
  for (const command of tricks) {
    // bash は、この語を 2 語に展開する（ガードが読む語の数と食い違う）
    assert.equal(decision(bash(t, command, { now: at(61) }, 'auto-1')), 'deny', command)
    // ガードがなくても（hook が動かない、引き渡しの環境変数が届かない）、自動改善の実行中は、人だけの操作を受け付けない
    const run = spawnSync('bash', ['-c', command], { cwd: t.repo, env: { ...t.env, PATH: `${join(ROOT, 'bin')}:${t.env.PATH}`, HARNESS_NOW: at(62) }, encoding: 'utf8' })
    assert.match(run.stdout, /^見送り：自動改善が実行中です/, command)
  }
  assert.deepEqual(note(t, ['trial', 'list', '--json']).json, [])
  assert.equal(note(t, ['list', '--key', 'route-placement', '--json']).json.length, 2)
  // 通常のセッションでも、harness-note の引数の、引用の外の { } * ? [ ] ~ は断る
  for (const command of ['harness-note add {--session=s2,--category} --session human-1 --category dev/mistake --key some-key --text x', 'harness-note pending show route-*']) {
    const run = bash(t, command, { now: at(63) }, 'human-1')
    assert.equal(run.status, 2, command)
    assert.match(run.stderr, /引用の外の \{ \} \* \? \[ \] ~ は使えません.*ルール：harness-note-call/)
  }
})

test('通常のセッションでも、ほかのコマンドで包んだ harness-note の呼び出しは断る（引数の --session を確かめられないため）', () => {
  const t = makeEnv()
  knownSession(t, 'human-1')
  const script = join(ROOT, 'scripts/note.mjs')
  const wrapped = [
    'command harness-note add --session human-2 --category dev/mistake --key some-key --text x',
    'env HARNESS_SESSION_ID=human-2 harness-note add --category dev/mistake --key some-key --text x',
    'env -i harness-note keys',
    'exec harness-note keys',
    'nohup harness-note keys',
    'timeout 5 harness-note keys',
    'xargs harness-note add --session',
    `node ${script} add --session human-2 --category dev/mistake --key some-key --text x`,
    'node plugins/self-improve/scripts/note.mjs keys',
    `bash ${NOTE} keys`,
    `cd /tmp && command ${NOTE} keys`,
    // 別の場所にある同じ名前のコマンドや、スクリプトを直接実行する形も、直接の呼び出しとは見なさない
    './harness-note add --session human-2 --category dev/mistake --key some-key --text x',
    '/opt/other-copy/bin/harness-note keys',
    `${script} keys`,
  ]
  for (const command of wrapped) {
    const run = bash(t, command, {}, 'human-1')
    assert.equal(run.status, 2, command)
    assert.match(run.stderr, /harness-note は、ほかのコマンド（command、env、node、bash など）で包まずに、パスも付けずに/, command)
  }
  // 書式の検査による拒否は、失敗の信号に数えない
  assert.deepEqual(events(t), [])
  // 呼び出しではないもの（ファイルとして触るだけ、あるかどうかを確かめるだけ）は通す
  writeFiles(t.repo, { 'scripts/note.mjs': '// このリポジトリ自身の、別のスクリプト\n' })
  for (const command of ['command -v harness-note', 'which harness-note', `cat ${script}`, `ls -l ${NOTE}`, 'git add plugins/self-improve/scripts/note.mjs', 'node scripts/note.mjs build', 'echo "harness-note の使い方"']) {
    assert.equal(decision(bash(t, command, {}, 'human-1')), 'allow', command)
  }
  // 直接の呼び出しは、これまでどおり通る
  assert.equal(decision(bash(t, 'harness-note keys', {}, 'human-1')), 'allow')
  assert.equal(decision(bash(t, `${NOTE} keys --session human-1`, {}, 'human-1')), 'allow')
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
  // --session を省いた harness-note は通さない（引き渡しの環境変数が届かないと、別のセッションと推定されて「人」の操作になる）
  for (const command of ['harness-note review done chg-1 --decision keep', "harness-note trial add --key free-key2 --text '推定の ID で入れた 1 行'", 'harness-note keys']) {
    const denied = bash(t, command, opts, 'auto-1')
    assert.equal(decision(denied), 'deny', command)
    assert.match(denied.stderr, /--session auto-1 をちょうど 1 つ付けてください/, command)
  }
  // ほかのセッションは、--session を省いてよい
  assert.equal(decision(bash(t, 'harness-note keys', opts, 'human-1')), 'allow')
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

test('早い判定：することがないと言い切れるときだけ、lib を読み込まずに抜ける（迷うときは先へ進む）', async () => {
  const { nothingToDo } = await import('../scripts/guard-harness.mjs')
  const t = makeEnv({ config: AUTO })
  const none = makeEnv({ initialized: false })
  const saved = { ...process.env }
  const withEnv = (env, fn) => {
    for (const key of ['HARNESS_DATA_DIR', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'HARNESS_DISABLE', 'HARNESS_TEST']) delete process.env[key]
    Object.assign(process.env, env)
    try {
      return fn()
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  }
  const input = (tool, session = 'human-1', cwd = t.repo) => ({ session_id: session, cwd, tool_name: tool, tool_input: {} })
  const data = { HARNESS_DATA_DIR: t.data, HARNESS_TEST: '1' }
  withEnv(data, () => {
    // init していない場所では、どのツールでも抜ける
    for (const tool of ['Read', 'Bash', 'Write', 'mcp__x__y']) assert.equal(nothingToDo(input(tool, 'human-1', none.repo)), true, tool)
    // セッションを始めた場所（CLAUDE_PROJECT_DIR）が init 済みなら、cwd がどこでも抜けない
    process.env.CLAUDE_PROJECT_DIR = t.repo
    assert.equal(nothingToDo(input('Bash', 'human-1', none.repo)), false)
    delete process.env.CLAUDE_PROJECT_DIR
    // init 済み：ファイルの書き込みと Bash は、必ず先へ進む。ほかのツールは、ロックも lock を試みた記録もなければ抜ける
    for (const tool of ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.equal(nothingToDo(input(tool)), false, tool)
    for (const tool of ['Read', 'Grep', 'Glob', 'Skill', 'Agent', 'mcp__github__create_pull_request']) assert.equal(nothingToDo(input(tool)), true, tool)
    assert.equal(nothingToDo(input('Read', 'human-1', join(t.repo, 'harness'))), true)
  })
  // データ領域の場所が環境変数から分からないときは、言い切らない
  withEnv({}, () => assert.equal(nothingToDo(input('Read')), false))
  withEnv({ HARNESS_DATA_DIR: 'relative/path' }, () => assert.equal(nothingToDo(input('Read')), false))
  withEnv({ CLAUDE_PLUGIN_DATA: t.data }, () => assert.equal(nothingToDo(input('Read')), true))
  withEnv({ ...data, HARNESS_DISABLE: '1' }, () => assert.equal(nothingToDo(input('Bash')), true))

  // ロックがあるあいだは、どのセッションのどのツールも先へ進む（ロック中のセッションは、通すツールの一覧で判定するため）
  startAuto(t, ['route-placement'])
  withEnv(data, () => {
    for (const session of ['auto-1', 'human-1']) assert.equal(nothingToDo(input('Read', session)), false, session)
  })
  // ロックが外れたあと：lock を試みたセッションは先へ進む（外へ働きかけるツールに確認を挟むため）。ほかのセッションは抜ける
  finishAuto(t)
  withEnv(data, () => {
    assert.equal(nothingToDo(input('mcp__github__create_pull_request', 'auto-1')), false)
    assert.equal(nothingToDo(input('mcp__github__create_pull_request', 'human-1')), true)
  })
  // 判定そのものは、早い判定を入れる前と同じ
  assert.equal(decision(pre(t, 'mcp__github__create_pull_request', { title: 'x' }, {}, 'auto-1')), 'ask')
  assert.equal(decision(pre(t, 'mcp__github__create_pull_request', { title: 'x' }, {}, 'human-1')), 'allow')
  // 読めないロックのファイルがあるときも、先へ進む（拒否の側に倒すため）
  writeFileSync(join(t.data, 'state', repoId(t), 'lock.json'), '{"session_id":')
  withEnv(data, () => assert.equal(nothingToDo(input('Read')), false))
})

test('壊れた入力でも、作業は止めない', () => {
  const t = makeEnv()
  const run = spawnSync(process.execPath, [script('guard-harness.mjs')], { input: 'not json', encoding: 'utf8', cwd: t.repo, env: t.env })
  assert.equal(run.status, 0)
  assert.equal(decision(pre(t, 'Bash', {})), 'allow')
  assert.equal(decision(pre(t, 'Write', {})), 'allow')
  knownSession(t, 'x')
})
