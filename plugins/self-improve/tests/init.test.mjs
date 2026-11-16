import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../scripts/lib/core.mjs'
import { ROOT, decisionOf, guardRun, makeEnv, note, script, writeFiles } from './helpers.mjs'

const init = (t, dir = t.repo) => {
  const run = spawnSync(process.execPath, [script('init.mjs'), dir], { encoding: 'utf8', env: t.env, cwd: dir })
  return { status: run.status, json: JSON.parse(run.stdout) }
}

test('init: user 単位の初期設定。user の設定と失敗票の置き場所を作り、リポジトリには何も作らない。2 回目は何も上書きしない', () => {
  const t = makeEnv({ files: { '.gitignore': 'node_modules' } })
  const before = readdirSync(t.repo, { recursive: true }).map(String).sort()
  // init の前から、ガードは効いている（init はいらない）
  assert.equal(guardRun(t, 's', 'Bash', { command: 'git push --force' }).status, 2)

  const first = init(t)
  assert.equal(first.status, 0)
  assert.deepEqual(first.json.created, ['~/.claude/self-improve/config.json'])
  assert.deepEqual(first.json.skipped, [])
  assert.equal(first.json.user_dir, '~/.claude/self-improve')
  assert.deepEqual([first.json.settings_file, first.json.allow_rule, first.json.allow_rule_present], ['~/.claude/settings.json', 'Bash(harness-note *)', false])
  assert.deepEqual([first.json.repo.name, first.json.repo.inactive, first.json.repo.verify_config, first.json.repo.verify_config_exists, first.json.repo.override_dir],
    ['demo-app', null, 'harness/config.json', false, '~/.claude/self-improve/repos/demo-app'])
  assert.ok(existsSync(first.json.repo.verify_template))
  assert.ok(existsSync(join(t.user, 'incidents')))
  // user の設定は、初期値どおり。除外の一覧は空
  const config = JSON.parse(readFileSync(join(t.user, 'config.json'), 'utf8'))
  assert.deepEqual(config.exclude, [])
  assert.equal(config.auto.interval_days, 0)
  // 許可ルールは、スクリプトでは書かない（Claude が、人の確認を通して足す）
  assert.equal(existsSync(join(t.claudeHome, 'settings.json')), false)
  // リポジトリには、何も作らない（検証コマンドを使うときだけ、スキルが確認を通して harness/config.json を作る）
  assert.deepEqual(readdirSync(t.repo, { recursive: true }).map(String).sort(), before)
  assert.equal(readFileSync(join(t.repo, '.gitignore'), 'utf8'), 'node_modules')
  assert.match(note(t, ['status', '--session', 's']).stdout, /設定：~\/\.claude\/self-improve\/config\.json。/)

  // 2 回目：変えた設定を上書きしない。許可ルールや、検証コマンドの設定があれば、そう返す
  writeFiles(t.user, { 'config.json': { exclude: ['~/work/client-x'], auto: { interval_days: 7 } } })
  writeFiles(t.claudeHome, { 'settings.json': { permissions: { allow: ['Bash(harness-note *)'] } } })
  writeFiles(t.repo, { 'harness/config.json': { verify: [{ name: 'typecheck', run: 'true' }] } })
  const second = init(t)
  assert.deepEqual(second.json.created, [])
  assert.deepEqual(second.json.skipped, ['~/.claude/self-improve/config.json'])
  assert.deepEqual([second.json.allow_rule_present, second.json.repo.verify_config_exists], [true, true])
  assert.deepEqual(JSON.parse(readFileSync(join(t.user, 'config.json'), 'utf8')).exclude, ['~/work/client-x'])
})

test('init: git リポジトリの外でも使える（user 単位の設定なので）。除外してあるリポジトリでは、その旨を返す', () => {
  const none = makeEnv({ git: false })
  const run = init(none)
  assert.equal(run.json.ok, true)
  assert.equal(run.json.repo, null)
  assert.ok(existsSync(join(none.user, 'config.json')))
  assert.equal(existsSync(join(none.repo, 'harness')), false)

  const excluded = makeEnv({ config: { exclude: ['~/..'] } })
  assert.match(init(excluded).json.repo.inactive, /exclude で、self-improve の対象から外してあります/)
})

test('init のあと、検証コマンドを使うと答えたときだけ、スキルが harness/config.json を作る（書き込みには確認が出る）', () => {
  const t = makeEnv()
  init(t)
  assert.equal(decisionOf(guardRun(t, 's', 'Write', { file_path: join(t.repo, 'harness/config.json'), content: '{"verify":[]}' })), 'ask')
  // user の設定と、許可ルールを足す先（~/.claude/settings.json は Claude Code 自身が確認を出す）
  assert.equal(decisionOf(guardRun(t, 's', 'Edit', { file_path: join(t.user, 'config.json') })), 'ask')
})

test('templates: user の設定のひな形は初期値どおり（exclude つき）。リポジトリ用は verify だけ。失敗票のひな形は 4 見出し', () => {
  const { exclude, ...config } = JSON.parse(readFileSync(join(ROOT, 'templates/config.json'), 'utf8'))
  const { verify, ...defaults } = DEFAULT_CONFIG
  assert.deepEqual(exclude, [])
  assert.deepEqual(verify, [])
  assert.deepEqual(config, defaults)
  assert.deepEqual(JSON.parse(readFileSync(join(ROOT, 'templates/repo-config.json'), 'utf8')), { verify: [] })
  const incident = readFileSync(join(ROOT, 'templates/incident.md'), 'utf8')
  for (const key of ['id', 'date', 'repo', 'repo_id', 'remote', 'area', 'category', 'signal', 'root_cause', 'cause_key', 'related', 'severity', 'status', 'control', 'applied_by', 'trial_started_at', 'promoted_at']) {
    assert.match(incident, new RegExp(`^${key}:`, 'm'), key)
  }
  for (const heading of ['## 何を頼んだか', '## 期待した結果', '## 実際の結果', '## 根拠']) assert.ok(incident.includes(heading))
})

test('init: 1.x の名残（harness/incidents/ の失敗票、harness/config.json の verify 以外の項目、settings.local.json の許可ルール）を知らせる。何も書き換えない', () => {
  const clean = makeEnv()
  assert.deepEqual(init(clean).json.repo.legacy, { incidents: 0, config_keys: [], allow_rule: false })

  const t = makeEnv({
    files: {
      'harness/config.json': { trial_review_days: 30, auto: { interval_days: 7 }, verify: [{ name: 'typecheck', run: 'true' }] },
      'harness/incidents/INC-2026-0001.md': '---\nid: INC-2026-0001\ncause_key: route-placement\n---\n',
      'harness/incidents/INC-2026-0002.md': '---\nid: INC-2026-0002\ncause_key: route-placement\n---\n',
      'harness/incidents/notes.md': 'メモ',
      '.claude/settings.local.json': { permissions: { allow: ['Bash(npm test)', 'Bash(harness-note *)'] } },
    },
  })
  const before = readdirSync(t.repo, { recursive: true }).map(String).sort()
  const run = init(t)
  assert.deepEqual(run.json.repo.legacy, { incidents: 2, config_keys: ['trial_review_days', 'auto'], allow_rule: true })
  assert.deepEqual(readdirSync(t.repo, { recursive: true }).map(String).sort(), before)
  assert.deepEqual(JSON.parse(readFileSync(join(t.repo, 'harness/config.json'), 'utf8')).auto, { interval_days: 7 })
})
