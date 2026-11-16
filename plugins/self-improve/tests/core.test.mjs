import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRepo, loadConfig, parseFrontmatter, DEFAULT_CONFIG } from '../scripts/lib/core.mjs'
import { ROOT, makeEnv, note, withEnv, writeFiles } from './helpers.mjs'

test('findRepo: 下の階層からでもリポジトリの根を見つけ、ID は共通ディレクトリから作る', () => {
  const t = makeEnv()
  mkdirSync(join(t.repo, 'src/routes'), { recursive: true })
  const top = findRepo(t.repo)
  const nested = findRepo(join(t.repo, 'src/routes'))
  assert.equal(nested.root, realpathSync(t.repo))
  assert.equal(nested.id, top.id)
  assert.match(top.id, /^demo-app-[0-9a-f]{12}$/)
  assert.equal(top.name, 'demo-app')
  assert.equal(findRepo(t.base), null)
})

test('findRepo: worktree（.git がファイル）でも、本体と同じ ID になる', () => {
  const t = makeEnv()
  const worktree = join(t.base, 'wt')
  mkdirSync(join(t.repo, '.git/worktrees/wt'), { recursive: true })
  writeFileSync(join(t.repo, '.git/worktrees/wt/commondir'), '../..\n')
  mkdirSync(worktree)
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(t.repo, '.git/worktrees/wt')}\n`)
  const main = findRepo(t.repo)
  const wt = findRepo(worktree)
  assert.equal(wt.id, main.id)
  assert.equal(wt.name, 'demo-app')
  assert.equal(wt.root, realpathSync(worktree))
})

test('findRepo: 本物の git worktree でも同じ ID になる', (ctx) => {
  if (spawnSync('git', ['--version']).status !== 0) return ctx.skip('git がない')
  const t = makeEnv()
  const repo = join(t.base, 'real')
  mkdirSync(repo)
  spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', repo])
  const git = (...args) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' })
  git('commit', '-q', '--allow-empty', '-m', 'init')
  const added = git('worktree', 'add', '-q', join(t.base, 'real-wt'), '-b', 'wt')
  if (added.status !== 0) return ctx.skip(`worktree を作れない：${added.stderr}`)
  assert.equal(findRepo(join(t.base, 'real-wt')).id, findRepo(repo).id)
})

test('設定は、初期値 → user の設定 → リポジトリごとの上書き、の順に重ねる。リポジトリの harness/config.json から読むのは verify だけ', () => {
  const load = (t) => withEnv(t, () => loadConfig(findRepo(t.repo)))
  // 何もなければ、初期値で動く（init はいらない）
  const none = makeEnv()
  const defaults = load(none)
  assert.deepEqual([defaults.auto, defaults.budget, defaults.verify, defaults.errors, defaults.notes], [DEFAULT_CONFIG.auto, DEFAULT_CONFIG.budget, [], [], []])

  const t = makeEnv({
    config: { auto: { interval_days: 0, max_per_run: 2 }, episode_retention_days: 30, candidates: { max_per_session: 5 } },
    userFiles: { 'repos/demo-app/config.json': { auto: { interval_days: 7 }, trial_review_days: 14 } },
    // リポジトリのファイルは、共有されたりプルで変わったりする。verify 以外は読まない
    files: { 'harness/config.json': { verify: [{ name: 'tc', run: 'true' }, { run: '' }], auto: { interval_days: 1, max_unreviewed: 99 }, episode_retention_days: 1 } },
  })
  const config = load(t)
  assert.deepEqual(config.auto, { ...DEFAULT_CONFIG.auto, interval_days: 7, max_per_run: 2 })
  assert.deepEqual([config.episode_retention_days, config.trial_review_days, config.candidates.max_per_session, config.candidates.min_sessions], [30, 14, 5, 2])
  assert.deepEqual(config.verify, [{ name: 'tc', run: 'true', timeout_sec: 240 }])
  assert.deepEqual(config.errors, [])
  assert.equal(config.notes.length, 1)
  assert.match(config.notes[0], /harness\/config\.json の auto、episode_retention_days は読みません（読むのは verify だけです）。~\/\.claude\/self-improve\/repos\/demo-app\/config\.json に移してください/)

  // 同じ名前のリポジトリを分けたいときは、ID のディレクトリを作れば、そちらを使う
  writeFiles(join(t.user, 'repos', findRepo(t.repo).id), { 'config.json': { auto: { interval_days: 3 } } })
  assert.equal(load(t).auto.interval_days, 3)

  // 読めない層は飛ばして、理由を残す
  const broken = makeEnv({ files: { 'harness/config.json': '{ broken' }, userFiles: { 'repos/demo-app/config.json': '{ nope' } })
  const fallback = load(broken)
  assert.equal(fallback.errors.length, 2)
  assert.equal(fallback.auto.interval_days, 0)
  assert.deepEqual(fallback.verify, [])
})

test('parseFrontmatter: 失敗票の先頭を読める', () => {
  const { data, keys, body } = parseFrontmatter(`---
id: INC-2026-0007
area: backend              # 値はリポジトリごとに決める
related: []
control: null
paths:
  - "src/routes/**"
  - src/api/**
description: "a: b"
---
本文`)
  assert.equal(data.id, 'INC-2026-0007')
  assert.equal(data.area, 'backend')
  assert.deepEqual(data.related, [])
  assert.equal(data.control, null)
  assert.deepEqual(data.paths, ['src/routes/**', 'src/api/**'])
  assert.equal(data.description, 'a: b')
  assert.deepEqual(keys, ['id', 'area', 'related', 'control', 'paths', 'description'])
  assert.equal(body, '本文')
  assert.equal(parseFrontmatter('見出しなし').data, null)
})

test('データの置き場所：環境変数 → SessionStart が引き渡した値 → 既定のパスの計算、の順に解決する', () => {
  const t = makeEnv()
  const viaEnv = note(t, ['status', '--json', '--session', 's1'])
  assert.equal(viaEnv.json.data_dir, t.data)
  assert.equal(viaEnv.json.data_dir_source, 'env')

  // CLAUDE_PLUGIN_DATA でも受け取れる（HARNESS_DATA_DIR が優先）
  const { HARNESS_DATA_DIR: _drop, ...bare } = t.env
  const viaPlugin = note({ ...t, env: { ...bare, CLAUDE_PLUGIN_DATA: join(t.base, 'plugin-data') } }, ['status', '--json', '--session', 's1'])
  assert.equal(viaPlugin.json.data_dir, join(t.base, 'plugin-data'))

  // 環境変数がなければ、既定のパス（--plugin-dir で読み込んだときの ID は self-improve-inline）
  const viaDefault = note({ ...t, env: bare }, ['status', '--json', '--session', 's1'])
  assert.equal(viaDefault.json.data_dir, join(t.claudeHome, 'plugins/data/self-improve-inline'))
  assert.equal(viaDefault.json.data_dir_source, 'default')

  // SessionStart が引き渡しのファイルを残していれば、そちらを使う
  const handed = join(t.claudeHome, 'plugins/data/self-improve-japan-da-man')
  writeFiles(handed, { 'handoff.json': { plugin: 'self-improve', plugin_root: ROOT, updated_at: '2026-11-16T00:00:00Z' } })
  writeFiles(join(t.claudeHome, 'plugins/data/other-plugin'), { 'handoff.json': { plugin: 'other', updated_at: '2027-01-01T00:00:00Z' } })
  const viaHandoff = note({ ...t, env: bare }, ['status', '--json', '--session', 's1'])
  assert.equal(viaHandoff.json.data_dir, handed)
  assert.equal(viaHandoff.json.data_dir_source, 'handoff')
})

test('セッション ID：--session → 環境変数 → 直近のセッション → 不明、の順に解決する。食い違う名乗りは拒否する', () => {
  const t = makeEnv()
  assert.deepEqual(note(t, ['status', '--json', '--session', 'flag-1']).json.session, { id: 'flag-1', source: 'flag' })
  // --session と環境変数が食い違うときは、どちらも信じない（別のセッションを名乗れないように）
  const mismatch = note(t, ['status', '--json', '--session', 'flag-1'], { env: { HARNESS_SESSION_ID: 'env-1' } })
  assert.equal(mismatch.status, 1)
  assert.match(mismatch.stderr, /^harness-note: .*--session/)
  assert.equal(note(t, ['status', '--json', '--session', 'env-1'], { env: { HARNESS_SESSION_ID: 'env-1' } }).json.session.id, 'env-1')
  // --session を 2 つ付けて、違う ID を名乗ることもできない
  assert.equal(note(t, ['status', '--json', '--session', 'a-1', '--session', 'b-1']).status, 1)
  assert.equal(note(t, ['status', '--json', '--session=a-1', '--session', 'a-1']).json.session.id, 'a-1')
  assert.deepEqual(note(t, ['status', '--json'], { env: { HARNESS_SESSION_ID: 'env-1' } }).json.session, { id: 'env-1', source: 'env' })
  assert.deepEqual(note(t, ['status', '--json'], { env: { CLAUDE_CODE_SESSION_ID: 'cc-1' } }).json.session, { id: 'cc-1', source: 'env' })
  const unknown = note(t, ['status', '--json']).json.session
  assert.equal(unknown.source, 'unknown')
  assert.match(unknown.id, /^unknown-\d{4}-\d{2}-\d{2}$/)
})

test('現在時刻の固定（HARNESS_NOW）は、テスト用の印（HARNESS_TEST=1）があるときだけ効く', () => {
  const t = makeEnv()
  const old = '2001-02-03T04:05:06.000Z'
  const add = (key, env) => note(t, ['add', '--session', 's1', '--category', 'dev/mistake', '--key', key, '--text', `${key} の気づき`], { now: old, env })
  const recordedAt = (key) => note(t, ['list', '--status', 'all', '--json']).json.find((c) => c.cause_key === key).at
  add('fixed-clock', {})
  assert.equal(recordedAt('fixed-clock'), old)
  // 印がなければ無視する（環境変数を 1 つ置くだけで、間隔や失効の判定をずらせないように）
  add('real-clock', { HARNESS_TEST: '' })
  assert.ok(Math.abs(Date.parse(recordedAt('real-clock')) - Date.now()) < 60_000)
})

test('リポジトリの特定：セッションを始めた場所を先に見る（入れ子のリポジトリへ cd しても、もとのリポジトリのまま）。worktree は cwd の側を使う', () => {
  const t = makeEnv()
  const inner = join(t.repo, 'vendor/inner')
  mkdirSync(join(inner, '.git'), { recursive: true })
  const root = (cwd, env = {}) => note(t, ['status', '--json', '--session', 's1'], { cwd, env }).json?.repo.root
  // cwd だけなら、いまいるリポジトリ（init はいらないので、入れ子のリポジトリでも動く）
  assert.equal(root(inner), realpathSync(inner))
  // セッションを始めた場所が分かれば、そちらを使う。hook には CLAUDE_PROJECT_DIR が渡り、
  // harness-note には SessionStart が HARNESS_PROJECT_DIR として引き渡す
  assert.equal(root(inner, { CLAUDE_PROJECT_DIR: t.repo }), realpathSync(t.repo))
  assert.equal(root(inner, { HARNESS_PROJECT_DIR: t.repo }), realpathSync(t.repo))
  // 同じリポジトリの worktree にいるときは、いまいる側のファイルを見る（ID は同じ）
  const worktree = join(t.base, 'wt')
  mkdirSync(join(t.repo, '.git/worktrees/wt'), { recursive: true })
  writeFileSync(join(t.repo, '.git/worktrees/wt/commondir'), '../..\n')
  mkdirSync(worktree)
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(t.repo, '.git/worktrees/wt')}\n`)
  const viaWorktree = note(t, ['status', '--json', '--session', 's1'], { cwd: worktree, env: { CLAUDE_PROJECT_DIR: t.repo } }).json.repo
  assert.deepEqual([viaWorktree.root, viaWorktree.id], [realpathSync(worktree), findRepo(t.repo).id])
})

test('harness-note: self-improve が動かない場所では使えない（理由を返し、何も書かない）', () => {
  const none = makeEnv({ git: false })
  const run = note(none, ['keys'])
  assert.equal(run.status, 1)
  assert.match(run.stderr, /^harness-note: ここでは使えません：git リポジトリではありません/)
  assert.equal(existsSync(none.data), false)

  const excluded = makeEnv({ config: { exclude: ['~/..'] } })
  const refused = note(excluded, ['add', '--session', 's1', '--category', 'dev/mistake', '--key', 'some-key', '--text', 'x'], { known: false })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /exclude で、self-improve の対象から外してあります/)
  assert.equal(existsSync(excluded.data), false)

  const off = makeEnv()
  assert.match(note(off, ['keys'], { env: { HARNESS_DISABLE: '1' } }).stderr, /HARNESS_DISABLE=1/)
})

test('harness-note status: どの設定とガードの定義を使っているかを出す', () => {
  const t = makeEnv({ config: { auto: { interval_days: 7 } }, userFiles: { 'guards.json': { rules: [] } }, files: { 'harness/guards.json': { rules: [] } } })
  const status = note(t, ['status', '--json', '--session', 's1']).json
  assert.deepEqual([status.user_dir, status.repo_dir, status.incidents_dir, status.recording], ['~/.claude/self-improve', '~/.claude/self-improve/repos/demo-app', '~/.claude/self-improve/incidents', true])
  assert.deepEqual(status.config_files, {
    user: { path: '~/.claude/self-improve/config.json', exists: true },
    override: { path: '~/.claude/self-improve/repos/demo-app/config.json', exists: false },
    repo: { path: 'harness/config.json', exists: false },
  })
  assert.deepEqual(status.guard_files.map((g) => [g.source, g.path, g.exists]), [
    ['default', 'guards.default.json', true],
    ['user', '~/.claude/self-improve/guards.json', true],
    ['user-repo', '~/.claude/self-improve/repos/demo-app/guards.json', false],
    ['repo', 'harness/guards.json', true],
  ])
  const text = note(t, ['status', '--session', 's1']).stdout
  assert.match(text, /設定：~\/\.claude\/self-improve\/config\.json。リポジトリごとの置き場所：~\/\.claude\/self-improve\/repos\/demo-app/)
  assert.match(text, /ガードの定義：guards\.default\.json、~\/\.claude\/self-improve\/guards\.json、harness\/guards\.json/)
})
