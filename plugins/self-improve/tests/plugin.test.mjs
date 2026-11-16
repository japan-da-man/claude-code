import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '../scripts/lib/core.mjs'
import { NOTE, ROOT, makeEnv } from './helpers.mjs'

const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')
const REPO = join(ROOT, '..', '..')

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(join(dir, f)).isFile())
}

test('plugin.json: 名前・説明（先頭にタグ）・作者が、マーケットプレイスの決まりどおり', () => {
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'))
  assert.equal(plugin.name, 'self-improve')
  assert.match(plugin.description, /^\[skills\] \[hooks\] /)
  assert.deepEqual(plugin.author, { name: 'japan-da-man' })
  // 版を持つ（版を上げたときだけ、入れてある環境に更新が届く）
  assert.match(plugin.version, /^2\.\d+\.\d+$/)
  assert.equal(JSON.parse(read('package.json')).scripts.test, 'node --test')
  // 外部の依存パッケージは入れない
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
})

test('hooks.json: 設計書の割り当てどおりのイベントに、実在するスクリプトを結び付ける', () => {
  const { hooks } = JSON.parse(read('hooks/hooks.json'))
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'])
  const expected = {
    SessionStart: ['session-start.mjs', false],
    UserPromptSubmit: ['log-event.mjs', true],
    PostToolUseFailure: ['log-event.mjs', true],
    PostToolUse: ['log-event.mjs', true],
    PreToolUse: ['guard-harness.mjs', false],
    Stop: ['on-stop.mjs', false],
  }
  for (const [event, [file, isAsync]] of Object.entries(expected)) {
    assert.equal(hooks[event].length, 1, event)
    const handler = hooks[event][0].hooks[0]
    assert.equal(handler.type, 'command')
    assert.equal(handler.command, `node "\${CLAUDE_PLUGIN_ROOT}/scripts/${file}"`)
    // 記録用の hook は async。作業を止めうる hook と、出力を返す hook は同期
    assert.equal(Boolean(handler.async), isAsync, event)
    assert.ok(existsSync(join(ROOT, 'scripts', file)))
  }
  // 同じイベントの hook は並列に走るので、Stop は 1 つのスクリプトにまとめる
  assert.equal(hooks.Stop[0].hooks.length, 1)
  // ガードは全ツールを見る（自動改善のセッションでは、通すツールの一覧で判定するため）。記録は、変更しうるツールだけ
  assert.equal(hooks.PreToolUse[0].matcher, undefined)
  assert.equal(hooks.PostToolUse[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit|Bash')
  // SessionStart は種類を絞らない（startup / resume / clear / compact のすべてで試用ルールを読み込む）
  assert.equal(hooks.SessionStart[0].matcher, undefined)
  // ステップ 4 の記録（Skill の呼び出し、ルールの読み込み）は、まだ入れない
  for (const event of ['UserPromptExpansion', 'InstructionsLoaded']) assert.equal(hooks[event], undefined)
})

test('bin/harness-note: 実行でき、設計書 9 章のサブコマンドを持つ', () => {
  accessSync(NOTE, constants.X_OK)
  assert.match(read('bin/harness-note').split('\n')[0], /^#!\/usr\/bin\/env node$/)
  const t = makeEnv()
  const help = spawnSync(NOTE, ['--help'], { encoding: 'utf8', env: t.env, cwd: t.repo })
  assert.equal(help.status, 0, help.stderr)
  const run = (args) => spawnSync(NOTE, args, { encoding: 'utf8', env: t.env, cwd: t.repo })
  for (const args of [['keys'], ['list'], ['trial', 'list'], ['skill', 'list'], ['pending', 'list'], ['incident', 'list'], ['incident', 'list', '--all'], ['incident', 'import'], ['report', 'list'], ['targets'], ['status'], ['review'], ['episodes', 'some-key'], ['report', 'close']]) {
    assert.equal(run(args).status, 0, args.join(' '))
  }
  for (const args of [['add'], ['trial', 'add'], ['trial', 'edit'], ['trial', 'remove'], ['skill', 'add'], ['skill', 'remove'], ['pending', 'add'], ['incident', 'add'], ['incident', 'set'], ['incident', 'show'], ['incident', 'nope'], ['promote'], ['promote', '--key', 'some-key', '--to', 'team'], ['lock'], ['unlock'], ['nope'], ['trial', 'nope']]) {
    const result = run(args)
    assert.equal(result.status, 1, args.join(' '))
    assert.match(result.stderr, /^harness-note: /)
  }
  assert.equal(run(['report', 'write', '--body', 'x']).status, 1)
})

test('skills: init・retro・auto-improve・review がある（harness-prune はステップ 4 で、まだない）', () => {
  assert.deepEqual(readdirSync(join(ROOT, 'skills')).sort(), ['auto-improve', 'init', 'retro', 'review'])
  for (const name of ['init', 'retro', 'auto-improve', 'review']) {
    const { data, body } = parseFrontmatter(read('skills', name, 'SKILL.md'))
    assert.equal(data.name, name)
    assert.ok(data.description.length > 40 && data.description.length < 1024, name)
    assert.match(data['allowed-tools'], /Bash\(harness-note \*\)/)
    assert.ok(body.length > 200)
    // スキルが呼ぶスクリプトは実在する
    for (const match of body.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+\.(?:mjs|md))/g)) assert.ok(existsSync(join(ROOT, match[1])), `${name}: ${match[1]}`)
  }
  // 自動改善は、最初に lock、最後に unlock。セッション ID はスキルの置き換えで渡す
  const auto = read('skills/auto-improve/SKILL.md')
  assert.match(auto, /harness-note lock --session \$\{CLAUDE_SESSION_ID\}/)
  assert.match(auto, /harness-note unlock --session \$\{CLAUDE_SESSION_ID\}/)
  // lock 中に通る Bash は「--session がちょうど 1 つ付いた harness-note」だけなので、スキルの中の呼び出しには、すべて付ける
  const calls = [...auto.matchAll(/^\s*harness-note [^\n]*$/gm)].map((m) => m[0].trim())
  assert.ok(calls.length >= 8)
  for (const call of calls) assert.match(call, /--session \$\{CLAUDE_SESSION_ID\}/, call)
  // 記録（report write）は、unlock より前
  assert.ok(auto.indexOf('harness-note report write') < auto.indexOf('harness-note unlock'))
  assert.equal(parseFrontmatter(auto).data['allowed-tools'], 'Bash(harness-note *)')
})

test('文書：README・SCHEDULING.md・DESIGN.md を同梱し、未実装のもの（ステップ 4）はそう書く', () => {
  for (const file of ['README.md', 'SCHEDULING.md', 'DESIGN.md']) assert.ok(existsSync(join(ROOT, file)), file)
  assert.match(read('README.md'), /harness-prune[^\n]*未実装（ステップ4）|未実装（ステップ4）[^\n]*harness-prune/)
  assert.match(read('SCHEDULING.md'), /未実装（ステップ4）/)
  const design = read('DESIGN.md')
  for (let chapter = 1; chapter <= 14; chapter++) assert.match(design, new RegExp(`^## ${chapter}\\. `, 'm'), `${chapter} 章`)
})

test('公開リポジトリなので、ローカルの絶対パスや個人の情報を入れない', () => {
  const forbidden = [/\/home\/[a-z]/, /\/Users\/[A-Za-z]/, /@gmail\.com/, /session_01[A-Za-z0-9]{10,}/, /\/tmp\/claude-/]
  for (const file of filesUnder(ROOT)) {
    if (file.startsWith('node_modules') || file.startsWith('.claude-plugin/types')) continue
    const text = read(file)
    for (const re of forbidden) assert.doesNotMatch(text, re, file)
  }
})

test('マーケットプレイスに登録されている。bundle には入れない（bin/ を持つプラグインは claude.ai と Cowork で入らないため）', () => {
  const marketplace = JSON.parse(readFileSync(join(REPO, '.claude-plugin/marketplace.json'), 'utf8'))
  const entry = marketplace.plugins.find((p) => p.name === 'self-improve')
  assert.deepEqual([entry.source, entry.description], ['./plugins/self-improve', JSON.parse(read('.claude-plugin/plugin.json')).description])
  const bundle = JSON.parse(readFileSync(join(REPO, 'plugins/japan-da-man-mods/.claude-plugin/plugin.json'), 'utf8'))
  assert.equal(bundle.dependencies.includes('self-improve'), false)
  assert.doesNotMatch(bundle.description, /self-improve/)
  assert.doesNotMatch(marketplace.plugins.find((p) => p.name === 'japan-da-man-mods').description, /self-improve/)
  // 個別に入れることと、その理由を、両方の README に書く
  const rootReadme = readFileSync(join(REPO, 'README.md'), 'utf8')
  assert.match(rootReadme, /\| \[self-improve\]\(plugins\/self-improve\) \|/)
  for (const text of [rootReadme, read('README.md')]) {
    assert.match(text, /claude plugin install self-improve@japan-da-man/)
    assert.match(text, /bundle[^\n]*(入っていない|入れていない)/)
    assert.match(text, /bin\/[^\n]*claude\.ai と Cowork/)
  }
})
