// どこで動くか（scope.mjs）。init はいらず、除外していない、すべての git リポジトリで動く。
// ガードの早い判定と、記録する側は、同じ判定を使う。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeHome, excludedReason, gitRootOf, readUserConfig, resolveScope } from '../scripts/lib/scope.mjs'
import { nothingToDo } from '../scripts/guard-harness.mjs'
import { at, dataFiles, decisionOf, events, guardRun, makeEnv, note, runHook, session, withEnv, writeFiles } from './helpers.mjs'

const gitRepo = (dir) => {
  mkdirSync(join(dir, '.git'), { recursive: true })
  return dir
}
// 4 つの hook と harness-note を、そのリポジトリのセッションとして動かす。何か記録・拒否・出力したら、その内容を返す。
function exercise(t, { cwd = t.repo, env = {} } = {}) {
  const base = { session_id: 'sess-1', cwd }
  const opts = { env, now: at(0) }
  const outputs = [
    runHook('session-start.mjs', { ...base, hook_event_name: 'SessionStart', source: 'startup' }, t, opts),
    runHook('log-event.mjs', { ...base, hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt: '違う、戻して' }, t, opts),
    runHook('log-event.mjs', { ...base, hook_event_name: 'PostToolUseFailure', prompt_id: 'p1', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' }, t, opts),
    runHook('guard-harness.mjs', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force' } }, t, opts),
    runHook('guard-harness.mjs', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(cwd, 'CLAUDE.md') } }, t, opts),
    runHook('on-stop.mjs', { ...base, hook_event_name: 'Stop', prompt_id: 'p1', last_assistant_message: 'x' }, t, opts),
  ]
  return outputs.map((run) => [run.status, run.stdout, run.stderr])
}
const SILENT = Array.from({ length: 6 }, () => [0, '', ''])

test('init しなくても、すべての git リポジトリで動く（user の設定がなくても、初期値で動く）', () => {
  const t = makeEnv()
  assert.equal(existsSync(join(t.user, 'config.json')), false)
  assert.equal(existsSync(join(t.repo, 'harness')), false)
  const s = session(t)
  s.start('startup', { now: at(0) })
  s.prompt('p1', 'テストを直して', { now: at(1) })
  s.failed('p1', 'Bash', { command: 'npm test' }, 'Exit code 1', { now: at(2) })
  // ガードが効く
  assert.equal(guardRun(t, 'sess-1', 'Bash', { command: 'git push --force' }, { now: at(3) }).status, 2)
  // 信号があったターンなので、事象メモを作り、改善候補の確認を頼む
  const stop = s.stop('p1', '直しました', { now: at(4) })
  assert.match(stop.json.hookSpecificOutput.additionalContext, /ターン終了時の確認です/)
  assert.deepEqual(events(t).map((e) => e.type), ['prompt', 'tool_failure', 'guard_denied', 'asked'])
  assert.equal(dataFiles(t, 'episodes').length, 1)
  assert.match(note(t, ['add', '--session', 'sess-1', '--category', 'dev/mistake', '--key', 'flaky-test', '--text', 'テストが不安定'], { now: at(5), known: false }).stdout, /記録しました/)
  // リポジトリには、何も作らない
  assert.equal(existsSync(join(t.repo, 'harness')), false)
  assert.equal(existsSync(join(t.repo, '.claude')), false)
})

test('git リポジトリでない場所、除外した場所、HARNESS_DISABLE=1 では、何も記録せず、何も止めない', () => {
  const cases = [
    ['git リポジトリでない', makeEnv({ git: false }), {}],
    ['exclude に書いたリポジトリ', (() => {
      const t = makeEnv()
      writeFiles(t.user, { 'config.json': { exclude: [t.repo] } })
      return t
    })(), {}],
    ['exclude に書いたディレクトリの下のリポジトリ（~/ で始まるパス）', (() => {
      const t = makeEnv({ config: { exclude: ['~/work'] } })
      t.repo = gitRepo(join(t.home, 'work/client-x/app'))
      return t
    })(), {}],
    ['HARNESS_DISABLE=1', makeEnv(), { HARNESS_DISABLE: '1' }],
  ]
  for (const [label, t, env] of cases) {
    assert.deepEqual(exercise(t, { env }), SILENT, label)
    assert.equal(existsSync(t.data), false, label)
    assert.equal(note(t, ['keys'], { cwd: t.repo, env }).status, 1, label)
  }
})

test('ホームディレクトリそのもの（ホームを git で管理している場合）と、node_modules の中は、組み込みで除外する', () => {
  const t = makeEnv()
  // ホームそのものが git リポジトリ（dotfiles の管理など）。ホームの下の、ふつうのディレクトリで始めたセッション
  gitRepo(t.home)
  mkdirSync(join(t.home, 'notes'))
  for (const cwd of [t.home, join(t.home, 'notes')]) {
    const view = { ...t, repo: cwd }
    assert.deepEqual(exercise(view), SILENT, cwd)
  }
  // node_modules の中のリポジトリ（依存パッケージを git で取ってきたもの）
  const dep = gitRepo(join(t.repo, 'node_modules/some-dep'))
  assert.deepEqual(exercise({ ...t, repo: dep }), SILENT)
  assert.equal(existsSync(t.data), false)
  // ホームの下にある、別のリポジトリは動く
  const project = gitRepo(join(t.home, 'src/app'))
  assert.equal(guardRun({ ...t, repo: project }, 'sess-1', 'Bash', { command: 'git push --force' }).status, 2)
  withEnv(t, () => {
    assert.deepEqual([resolveScope(t.home).reason, resolveScope(dep).reason, resolveScope(project).reason], ['home', 'node_modules', null])
  })
})

test('セッションを始めたリポジトリが除外されていれば、そのセッション全体を止める。除外していないリポジトリで始めたセッションは、cd しても続く', () => {
  const t = makeEnv()
  const client = gitRepo(join(t.base, 'client-x'))
  writeFiles(t.user, { 'config.json': { exclude: [client] } })
  // 除外したリポジトリで始めたセッション：除外していないリポジトリへ cd しても、何もしない
  assert.deepEqual(exercise(t, { cwd: t.repo, env: { CLAUDE_PROJECT_DIR: client } }), SILENT)
  assert.equal(existsSync(t.data), false)
  // 除外していないリポジトリで始めたセッション：除外したリポジトリへ cd しても、ガードは効き続ける（セッションのリポジトリで判定する）
  const denied = runHook('guard-harness.mjs', { session_id: 's', cwd: client, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force' } }, t, { env: { CLAUDE_PROJECT_DIR: t.repo } })
  assert.equal(denied.status, 2)
  // cwd だけで判定するとき（セッションを始めた場所が分からないとき）は、cwd のリポジトリで決める
  assert.equal(decisionOf(guardRun({ ...t, repo: client }, 's', 'Bash', { command: 'git push --force' })), 'allow')
})

test('除外は、実体のパスと、worktree の本体でも判定する', () => {
  const t = makeEnv()
  const real = gitRepo(join(t.base, 'real/client-x'))
  // リンク経由のパスを exclude に書いても、リンク経由で開いても、同じリポジトリとして除外する
  symlinkSync(join(t.base, 'real'), join(t.base, 'link'))
  writeFiles(t.user, { 'config.json': { exclude: [join(t.base, 'link/client-x')] } })
  for (const cwd of [real, join(t.base, 'link/client-x')]) assert.deepEqual(exercise({ ...t, repo: cwd }), SILENT, cwd)
  // 除外したリポジトリの worktree（別の場所にある）も、除外する
  const worktree = join(t.base, 'wt')
  mkdirSync(join(real, '.git/worktrees/wt'), { recursive: true })
  writeFileSync(join(real, '.git/worktrees/wt/commondir'), '../..\n')
  mkdirSync(worktree)
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(real, '.git/worktrees/wt')}\n`)
  assert.deepEqual(exercise({ ...t, repo: worktree }), SILENT)
  // 名前の前半が同じだけの、別のリポジトリは除外しない
  const sibling = gitRepo(join(t.base, 'real/client-xyz'))
  assert.equal(guardRun({ ...t, repo: sibling }, 's', 'Bash', { command: 'git push --force' }).status, 2)
  withEnv(t, () => {
    const user = readUserConfig()
    assert.equal(excludedReason(gitRootOf(real), user), 'exclude')
    assert.equal(excludedReason(gitRootOf(sibling), user), null)
  })
})

test('user の設定が読めないあいだは、ガードは効かせたまま、記録と掃除を止める（ガードの拒否も記録しない）', () => {
  for (const [label, content, message] of [
    ['JSON として読めない', '{ "exclude": [', /config\.json：JSON として読めません（.*）。直すまで、記録と掃除を止めています（ガードは効いています）/],
    ['exclude が配列でない', { exclude: '~/work/client-x' }, /exclude は、パスの配列で書いてください/],
    ['exclude に解釈できない値がある', { exclude: ['client-x', 42] }, /exclude の client-x、42 を解釈できません。絶対パスか、~\/ で始まるパスで書いてください/],
  ]) {
    const t = makeEnv()
    writeFiles(t.user, { 'config.json': content })
    // 前のセッションで残った古い記録（掃除されないことを確かめる）
    writeFiles(join(t.data, 'episodes', 'old-repo-000000000000'), { 'ep-old.md': '古い事象メモ' })
    const s = session(t)
    const start = s.start('startup', { now: at(0) })
    // 読めないことは、毎回知らせる
    assert.match(start.json.systemMessage, message, label)
    assert.match(start.json.systemMessage, /^\[self-improve\] ~\/\.claude\/self-improve\/config\.json：/)
    s.prompt('p1', '違う、戻して', { now: at(1) })
    s.failed('p1', 'Bash', { command: 'npm test' }, 'Exit code 1', { now: at(2) })
    s.used('p1', 'Write', { file_path: join(t.repo, 'src/a.ts') }, { now: at(3) })
    // ガードは効く。拒否も、確認も出る
    const denied = guardRun(t, 'sess-1', 'Bash', { command: 'git push --force' }, { now: at(4) })
    assert.equal(denied.status, 2, label)
    assert.match(denied.stderr, /ルール：git-force-push/)
    assert.equal(decisionOf(guardRun(t, 'sess-1', 'Write', { file_path: join(t.repo, 'CLAUDE.md') }, { now: at(4) })), 'ask', label)
    const stop = s.stop('p1', 'x', { now: at(5) })
    assert.deepEqual([stop.status, stop.stdout, stop.stderr], [0, '', ''], label)
    // 何も記録していない（拒否の記録も、セッションの状態も、事象メモも）。掃除もしていない
    assert.deepEqual(dataFiles(t, 'events'), [], label)
    assert.deepEqual(dataFiles(t, 'state'), [], label)
    assert.deepEqual(dataFiles(t, 'episodes'), ['old-repo-000000000000/ep-old.md'], label)
    assert.match(note(t, ['add', '--session', 'sess-1', '--category', 'dev/mistake', '--key', 'some-key', '--text', 'x'], { known: false }).stdout, /記録しません：~\/\.claude\/self-improve\/config\.json を読めないので、記録を止めています/)
    assert.equal(note(t, ['status', '--json', '--session', 'sess-1']).json.recording, false)
    withEnv(t, () => assert.deepEqual([resolveScope(t.repo).active, resolveScope(t.repo).recording], [true, false]))
  }
})

test('exclude の書き間違いを知らせる（見つからないパスは、知らせるだけで、除外は効かせる）', () => {
  const t = makeEnv({ config: { exclude: ['~/work/cliant-x', '/no/such/place'] } })
  const first = session(t, 's1').start('startup', { now: at(0) })
  assert.match(first.json.systemMessage, /設定の注意：exclude の ~\/work\/cliant-x が見つかりません（書き間違いでなければ、そのままで構いません）。exclude の \/no\/such\/place が見つかりません/)
  // 記録は止めない（解釈はできている）
  assert.equal(note(t, ['status', '--json', '--session', 's1']).json.recording, true)
  assert.deepEqual(note(t, ['status', '--json', '--session', 's1']).json.config_notes.length, 2)
  // user 単位の知らせなので、閉じれば、ほかのリポジトリでも出ない
  note(t, ['report', 'close', '--session', 's1'], { now: at(1) })
  const other = gitRepo(join(t.base, 'other-app'))
  assert.equal(runHook('session-start.mjs', { session_id: 's2', cwd: other, hook_event_name: 'SessionStart', source: 'startup' }, { ...t, repo: other }, { now: at(2) }).stdout, '')
})

test('早い判定と、記録する側の判定は、同じ結果になる（どの場所でも）', () => {
  const t = makeEnv()
  const places = {
    active: t.repo,
    nested: gitRepo(join(t.repo, 'vendor/inner')),
    nodeModules: gitRepo(join(t.repo, 'node_modules/dep')),
    excluded: gitRepo(join(t.base, 'client-x')),
    underExcluded: gitRepo(join(t.base, 'clients/a/app')),
    plain: join(t.base, 'plain'),
  }
  mkdirSync(places.plain)
  writeFiles(t.user, { 'config.json': { exclude: [places.excluded, join(t.base, 'clients')] } })
  for (const [name, cwd] of Object.entries(places)) {
    for (const project of [null, t.repo, places.excluded]) {
      const env = project ? { CLAUDE_PROJECT_DIR: project } : {}
      // 早い判定（guard-harness.mjs の先頭）
      // （hook のプロセスは、その場所を作業ディレクトリにして動く。テストのプロセスでも、そろえる）
      const fast = withEnv(t, () => {
        const before = process.cwd()
        process.chdir(cwd)
        try {
          return nothingToDo({ session_id: 's', cwd, tool_name: 'Bash', tool_input: {} })
        } finally {
          process.chdir(before)
        }
      }, env)
      // 記録する側（hook が文脈を作れるか）。SessionStart が状態を書くかどうかで見る
      const view = makeEnv()
      const run = runHook('session-start.mjs', { session_id: 's', cwd, hook_event_name: 'SessionStart', source: 'startup' }, { ...t, repo: cwd, data: view.data, env: { ...t.env, HARNESS_DATA_DIR: view.data } }, { env })
      const recorded = existsSync(view.data)
      assert.equal(fast, !recorded, `${name}（セッションを始めた場所：${project ?? 'なし'}）`)
      assert.equal(run.status, 0)
    }
  }
})

test('scope.mjs は、Node.js の標準だけで書く（すべてのツール呼び出しで読み込むので、ほかのモジュールを読み込まない）', () => {
  const source = readFileSync(new URL('../scripts/lib/scope.mjs', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  assert.ok(imports.length > 0)
  for (const name of imports) assert.match(name, /^node:/)
  // ガードの先頭で読み込むのも、標準と scope.mjs だけ（lib/ のほかは、必要になってから読み込む）
  const guard = readFileSync(new URL('../scripts/guard-harness.mjs', import.meta.url), 'utf8')
  const top = [...guard.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(top.filter((name) => !name.startsWith('node:')), ['./lib/scope.mjs'])
})

test('中-4：.git があるのに共通ディレクトリを解決できないときは、上の階層へ探しに行かず、その場所をリポジトリとして扱う（ガードも記録も止まらない）', () => {
  const t = makeEnv()
  // 上へ探しに行くと、リポジトリでない（no_repo）か、ホーム（ホームを git で管理している）と判定されてしまう配置
  gitRepo(t.home)
  const broken = {
    'commondir の先がない': (dir) => writeFiles(dir, { '.git/commondir': 'nope\n' }),
    'commondir が空でない別の文字': (dir) => writeFiles(dir, { '.git/commondir': '../../../../no/such/place\n' }),
    'worktree の .git のファイルの形が違う': (dir) => {
      rmSync(join(dir, '.git'), { recursive: true })
      writeFileSync(join(dir, '.git'), 'garbage\n')
    },
    'worktree の .git のファイルの gitdir の先がない': (dir) => {
      rmSync(join(dir, '.git'), { recursive: true })
      writeFileSync(join(dir, '.git'), 'gitdir: /no/such/gitdir\n')
    },
  }
  for (const [label, breakIt, parent] of Object.entries(broken).flatMap(([l, f]) => [[`${l}（上はリポジトリでない）`, f, t.base], [`${l}（上はホーム）`, f, join(t.home, 'src')]])) {
    const repo = gitRepo(join(parent, `repo-${Object.keys(broken).indexOf(label.replace(/（.*$/, ''))}`))
    breakIt(repo)
    const here = { ...t, repo }
    const found = withEnv(t, () => gitRootOf(repo))
    assert.equal(found.root, repo, label)
    assert.ok(found.commonDir, label)
    withEnv(t, () => assert.deepEqual([resolveScope(repo).active, resolveScope(repo).recording], [true, true], label), { CLAUDE_PROJECT_DIR: repo })
    const project = { env: { CLAUDE_PROJECT_DIR: repo } }
    assert.equal(guardRun(here, 's', 'Bash', { command: 'git push --force' }, project).status, 2, label)
    assert.equal(decisionOf(guardRun(here, 's', 'Write', { file_path: join(repo, 'CLAUDE.md') }, project)), 'ask', label)
  }
  // 壊れていない、ふつうのリポジトリの ID は変わらない（commondir がないときは .git が共通ディレクトリ）
  withEnv(t, () => assert.equal(gitRootOf(t.repo).commonDir, join(t.repo, '.git')))
})

test('軽微-1：exclude に解釈できない値が混ざっていても、正しく書けている値の除外は効かせる（ほかの場所は、ガードは効かせたまま記録を止める）', () => {
  const t = makeEnv()
  const excluded = gitRepo(join(t.base, 'client-x'))
  writeFiles(t.user, { 'config.json': { exclude: [excluded, 'relative/x'] } })
  withEnv(t, () => {
    const there = resolveScope(excluded)
    assert.deepEqual([there.active, there.reason, Boolean(there.user.error)], [false, 'exclude', true])
    const here = resolveScope(t.repo)
    assert.deepEqual([here.active, here.recording], [true, false])
  })
  assert.deepEqual(exercise({ ...t, repo: excluded }), SILENT)
  assert.equal(guardRun(t, 's', 'Bash', { command: 'git push --force' }).status, 2)
})

test('軽微-2：大文字小文字を区別しないファイルシステム（macOS、Windows）では、exclude を大文字小文字を区別せずに比べる', () => {
  const t = makeEnv()
  const repo = gitRepo(join(t.base, 'Work/Client-X'))
  writeFiles(t.user, { 'config.json': { exclude: [join(t.base, 'work/client-x')] } })
  const saved = Object.getOwnPropertyDescriptor(process, 'platform')
  const as = (platform, fn) => {
    Object.defineProperty(process, 'platform', { ...saved, value: platform })
    try {
      return withEnv(t, fn)
    } finally {
      Object.defineProperty(process, 'platform', saved)
    }
  }
  for (const platform of ['darwin', 'win32']) as(platform, () => assert.equal(excludedReason(gitRootOf(repo), readUserConfig()), 'exclude', platform))
  // 区別するファイルシステム（Linux）では、別の場所として扱う
  as('linux', () => assert.equal(excludedReason(gitRootOf(repo), readUserConfig()), null))
})

test('軽微-5：テスト用の環境変数（HARNESS_CLAUDE_HOME、HARNESS_GUARD_DRYRUN）は、HARNESS_TEST=1 のときだけ読む', () => {
  const t = makeEnv()
  // リポジトリの中に、user 側の置き場所に見せかけたものを置く（ここを向けられると、除外やガードの外しを差し込める）
  writeFiles(t.repo, { 'fake-claude/self-improve/config.json': { exclude: [t.repo] }, 'fake-claude/self-improve/guards.json': { disable_defaults: ['git-force-push'] } })
  const fake = { HARNESS_CLAUDE_HOME: join(t.repo, 'fake-claude'), HARNESS_GUARD_DRYRUN: '1' }
  // テストの印がなければ、どちらも読まない：ホームの ~/.claude を使い、ガードは効き、拒否も記録する
  const real = guardRun(t, 's', 'Bash', { command: 'git push --force' }, { env: { ...fake, HARNESS_TEST: '' } })
  assert.equal(real.status, 2)
  assert.deepEqual(events(t).map((e) => [e.type, e.rule]), [['guard_denied', 'git-force-push']])
  withEnv(t, () => assert.equal(claudeHome(), t.claudeHome), { ...fake, HARNESS_TEST: '' })
  // テストの印があれば読む（テストは、これで一時ディレクトリに向けている）
  assert.equal(guardRun(t, 's', 'Bash', { command: 'git push --force' }, { env: fake }).status, 0)
  withEnv(t, () => assert.equal(claudeHome(), join(t.repo, 'fake-claude')), fake)
})
