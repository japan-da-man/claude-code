import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { featureDir, projectHome } from '../line/paths.js'
import { enqueue, listQueue, readLock } from '../line/queue.js'
import { loadState } from '../line/state.js'
import { runLine } from '../line/line.js'

const ID = '20261018-share-memo'

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// 一時的なリポジトリ（origin は bare）と、工場の置き場所に仕様とシナリオを用意する。
function setup({ protectedPaths = ['**/*.entitlements'], workflows = false, models = {}, designSystem = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-line-'))
  const origin = join(root, 'origin.git')
  const repo = join(root, 'repo')
  execSync(`git init -q --bare -b main ${origin}`)
  mkdirSync(repo)
  git(repo, 'init -q -b main')
  git(repo, 'config user.email t@example.com')
  git(repo, 'config user.name t')
  mkdirSync(join(repo, '.factory'))
  writeFileSync(
    join(repo, '.factory', 'config.json'),
    JSON.stringify({ type: 'ios', ios: { project: 'App.xcodeproj', scheme: 'App', bundle_id: 'com.example.App' }, protected_paths: protectedPaths, models, max_rounds: 2, notify: { mac: true, pr_report: true } }),
  )
  writeFileSync(join(repo, 'README.md'), 'app\n')
  if (designSystem) {
    mkdirSync(join(repo, 'design-system'))
    writeFileSync(join(repo, 'design-system', 'copy.md'), '# 文言\n')
    writeFileSync(
      join(repo, 'design-system', 'design-system.json'),
      JSON.stringify({
        docs: ['design-system/README.md', 'design-system/copy.md'],
        protected_paths: ['design-system/**'],
        // Violation.swift があれば違反（終了コード 1）
        check: { command: `node -e "process.exit(require('fs').existsSync('Violation.swift')?1:0)"` },
      }),
    )
  }
  if (workflows) {
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n')
  }
  git(repo, 'add -A')
  git(repo, 'commit -q -m init')
  git(repo, `remote add origin ${origin}`)
  git(repo, 'push -q -u origin main')

  const home = join(root, 'home')
  const fdir = featureDir(projectHome(repo, home), ID)
  mkdirSync(join(fdir, 'scenarios'), { recursive: true })
  writeFileSync(join(fdir, 'spec.md'), '# 共有\n')
  writeFileSync(join(fdir, 'scenarios', 'share-01.md'), '---\nid: share-01\ntitle: a\nrequired: true\n---\n本文\n')
  writeFileSync(join(fdir, 'scenarios', 'share-02.md'), '---\nid: share-02\ntitle: b\nrequired: false\n---\n本文\n')
  enqueue(home, { repo, id: ID })
  return { root, repo, home, fdir, work: join(root, 'work') }
}

// judge: 周ごとに満足かどうかを返す関数。
function fakeDeps(s, { judge = () => true, testsPass = () => true, touch = 'Share.swift', ciPasses = true, blocked = () => false, violate = () => false, report = 'implemented' } = {}) {
  const calls = { claude: [], codex: [], gh: [], notify: [], round: 0, closed: [], verifies: 0 }
  const judgeRuns = (role) => {
    const runs = (role.prompt.match(/^- .*runs\//gm) || []).length
    const ok = judge(calls.round)
    return Array.from({ length: runs }, (_, i) => ({ run: i + 1, satisfied: ok, symptom: ok ? null : '保存されない' }))
  }
  const deps = {
    workRoot: s.work,
    now: () => 0,
    sleep: async () => {},
    log: () => {},
    claude: async (role) => {
      calls.claude.push(role)
      if (role.prompt.includes('機能を実装する担当')) {
        calls.round += 1
        calls.specInWorktree = existsSync(join(role.cwd, 'docs', 'factory', ID, 'spec.md'))
        writeFileSync(join(role.cwd, touch), `// round ${calls.round}\n`)
        if (violate(calls.round)) writeFileSync(join(role.cwd, 'Violation.swift'), '// Color.red\n')
        else if (existsSync(join(role.cwd, 'Violation.swift'))) git(role.cwd, 'rm -q Violation.swift')
        git(role.cwd, 'add -A')
        git(role.cwd, `commit -q -m "round ${calls.round}"`)
        return { result: report }
      }
      if (role.prompt.includes('記録する担当')) {
        calls.verifies += 1
        writeFileSync(join(role.cwd, 'log.md'), 'tapped\n')
        const b = blocked(calls.verifies)
        writeFileSync(join(role.cwd, 'result.json'), JSON.stringify({ completed: !b, blocked_by_tool: b, reason: b ? 'DEVICE_IN_USE' : '' }))
        return { result: '記録しました' }
      }
      return { result: '```json\n' + JSON.stringify(judgeRuns(role)) + '\n```' }
    },
    codex: async (role) => {
      calls.codex.push(role)
      return { result: JSON.stringify({ runs: judgeRuns(role) }) }
    },
    adapter: {
      udid: () => 'UDID',
      commands: () => ({ prebuild: null, build: 'true', test: 'true' }),
      buildAndTest: () => (testsPass(calls.round) ? { ok: true } : { ok: false, command: 'xcodebuild test', log: 'FAILED' }),
      findApp: () => '/x/App.app',
      resetApp: () => {},
      shutdown: () => {},
      closeSession: (session) => calls.closed.push(session),
    },
    gh: (argv) => {
      const args = argv.join(' ')
      calls.gh.push(args)
      if (args.startsWith('pr create')) return { ok: true, out: 'https://github.com/o/r/pull/7\n' }
      if (args.startsWith('pr checks')) return { ok: ciPasses, out: ciPasses ? 'All checks were successful' : 'build\tfail' }
      return { ok: true, out: '' }
    },
    notify: (title, body) => calls.notify.push({ title, body }),
  }
  return { deps, calls }
}

test('a feature that satisfies the scenarios is merged and the line stops', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s)
  await runLine({ home: s.home, deps })

  const state = loadState(s.fdir, {})
  assert.equal(state.status, 'merged')
  assert.equal(state.rounds.length, 1)
  assert.equal(state.rounds[0].score, 1)
  assert.equal(listQueue(s.home).length, 0)
  assert.equal(readLock(s.home), null)

  // 2 シナリオ × 3 回の検証と、シナリオごとの判定
  assert.equal(calls.claude.filter((r) => r.prompt.includes('記録する担当')).length, 6)
  assert.equal(calls.claude.filter((r) => r.prompt.includes('採点する担当')).length, 2)

  // 仕様はブランチにコミットされ、実装役のプロンプトにシナリオの場所は出てこない
  const implement = calls.claude.find((r) => r.prompt.includes('機能を実装する担当'))
  assert.doesNotMatch(implement.prompt, /scenarios/)
  assert.equal(implement.hide, s.home)
  assert.equal(calls.specInWorktree, true)
  assert.equal(git(s.repo, `branch --list factory/${ID}`), '')
  // マージしたら worktree は片づける
  assert.equal(existsSync(implement.cwd), false)

  assert.ok(calls.gh.some((a) => a.startsWith('pr create')))
  assert.ok(calls.gh.some((a) => a.startsWith('pr comment')))
  const merge = calls.gh.find((a) => a.startsWith('pr merge'))
  assert.match(merge, /--squash/)
  // --delete-branch は手元のチェックアウトを切り替えようとして worktree では失敗するので使わない
  assert.doesNotMatch(merge, /--delete-branch/)
  assert.equal(git(join(s.root, 'origin.git'), `branch --list factory/${ID}`), '')
  assert.match(calls.notify.at(-1).title, /マージ/)
  assert.ok(existsSync(join(s.fdir, 'report.md')))
})

test('symptoms from a failed round go to the next implement round', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s, { judge: (round) => round >= 2 })
  await runLine({ home: s.home, deps })
  const impls = calls.claude.filter((r) => r.prompt.includes('機能を実装する担当'))
  assert.equal(impls.length, 2)
  assert.match(impls[1].prompt, /保存されない/)
  assert.equal(loadState(s.fdir, {}).status, 'merged')
})

test('hitting the round limit leaves a draft PR and stops', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s, { judge: () => false })
  await runLine({ home: s.home, deps })
  const state = loadState(s.fdir, {})
  assert.equal(state.status, 'stopped')
  assert.equal(state.rounds.length, 2)
  const create = calls.gh.find((a) => a.startsWith('pr create'))
  assert.match(create, /--draft/)
  assert.equal(calls.gh.some((a) => a.startsWith('pr merge')), false)
  assert.match(calls.notify.at(-1).title, /止まりました/)
})

test('a broken build skips verification and reports the failure as the symptom', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s, { testsPass: (round) => round >= 2 })
  await runLine({ home: s.home, deps })
  const impls = calls.claude.filter((r) => r.prompt.includes('機能を実装する担当'))
  assert.match(impls[1].prompt, /ビルドか全テストが通らない/)
  assert.equal(loadState(s.fdir, {}).rounds[0].tests, false)
})

test('changing a protected file blocks the merge', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s, { touch: 'App.entitlements' })
  await runLine({ home: s.home, deps })
  assert.equal(loadState(s.fdir, {}).status, 'stopped')
  assert.equal(calls.gh.some((a) => a.startsWith('pr merge')), false)
  assert.match(readFileSync(join(s.fdir, 'report.md'), 'utf8'), /禁止ファイル/)
})

test('with a CI workflow the merge waits for checks, and a red CI stops the feature', async () => {
  const green = setup({ workflows: true })
  const g = fakeDeps(green)
  await runLine({ home: green.home, deps: g.deps })
  assert.ok(g.calls.gh.some((a) => a.startsWith('pr checks')))
  assert.equal(loadState(green.fdir, {}).status, 'merged')

  const red = setup({ workflows: true })
  const r = fakeDeps(red, { ciPasses: false })
  await runLine({ home: red.home, deps: r.deps })
  assert.equal(loadState(red.fdir, {}).status, 'stopped')
  assert.equal(r.calls.gh.filter((a) => a.startsWith('pr create')).length, 1)
  assert.equal(r.calls.gh.some((a) => a.startsWith('pr merge')), false)
})

test('every verify run closes its simulator session, before and after', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s)
  await runLine({ home: s.home, deps })
  const sessions = calls.claude.filter((r) => r.prompt.includes('記録する担当')).map((r) => /--session ([\w.-]+)/.exec(r.prompt)[1])
  for (const session of sessions) assert.equal(calls.closed.filter((c) => c === session).length, 2)
})

test('a run blocked by the tooling is retried once and not judged as a product failure', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s, { blocked: (n) => n === 1 })
  await runLine({ home: s.home, deps })
  assert.equal(calls.verifies, 7)
  assert.equal(loadState(s.fdir, {}).status, 'merged')
})

test('tooling that stays blocked stops the feature as a factory error, without symptoms', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s, { blocked: () => true })
  await runLine({ home: s.home, deps })
  const state = loadState(s.fdir, {})
  assert.equal(state.status, 'error')
  assert.match(state.error, /DEVICE_IN_USE/)
  assert.equal(calls.claude.filter((r) => r.prompt.includes('機能を実装する担当')).length, 1)
  assert.match(calls.notify.at(-1).title, /エラー/)
  assert.equal(listQueue(s.home).length, 0)
})

test('a merge that already went through on GitHub counts as merged when the step is retried', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s)
  const gh = deps.gh
  deps.gh = (argv, cwd) => {
    const a = argv.join(' ')
    if (a.startsWith('pr merge')) {
      calls.gh.push(a)
      return { ok: false, out: "failed to run git: fatal: 'main' is already used by worktree" }
    }
    if (a.startsWith('pr view')) {
      calls.gh.push(a)
      return { ok: true, out: 'MERGED\n' }
    }
    return gh(argv, cwd)
  }
  await runLine({ home: s.home, deps })
  assert.equal(loadState(s.fdir, {}).status, 'merged')
  assert.ok(calls.gh.some((a) => a.startsWith('pr view')))
})

test('with models.judge set to codex, judging goes to Codex read-only with the schema', async () => {
  const s = setup({ models: { judge: 'codex' } })
  const { deps, calls } = fakeDeps(s, { judge: (round) => round >= 2 })
  await runLine({ home: s.home, deps })
  assert.equal(calls.claude.filter((r) => r.prompt.includes('採点する担当')).length, 0)
  assert.equal(calls.codex.length, 4)
  assert.equal(calls.codex[0].sandbox, 'read-only')
  assert.equal(calls.codex[0].cwd, s.fdir)
  assert.match(calls.codex[0].schema, /judge\.schema\.json$/)
  // Codex の判定で見つかった症状も、次の周の実装役に渡る
  assert.match(calls.claude.filter((r) => r.prompt.includes('機能を実装する担当'))[1].prompt, /保存されない/)
  assert.equal(loadState(s.fdir, {}).status, 'merged')
})

test('with a design system, the implementer is told to follow it and cannot touch it', async () => {
  const s = setup({ designSystem: true })
  const { deps, calls } = fakeDeps(s)
  await runLine({ home: s.home, deps })
  const implement = calls.claude.find((r) => r.prompt.includes('機能を実装する担当'))
  assert.match(implement.prompt, /design-system\/README\.md/)
  assert.match(implement.prompt, /部品の候補/)
  assert.match(implement.prompt, /design-system\/\*\*/)
  assert.equal(loadState(s.fdir, {}).status, 'merged')
})

test('a design check violation fails the round, skips verification and hands the violations on', async () => {
  const s = setup({ designSystem: true })
  const { deps, calls } = fakeDeps(s, { violate: (round) => round === 1 })
  await runLine({ home: s.home, deps })
  const state = loadState(s.fdir, {})
  assert.equal(state.rounds[0].design, false)
  assert.equal(state.rounds[1].design, true)
  // 1 周目は検証しない（2 シナリオ × 3 回は 2 周目の分だけ）
  assert.equal(calls.verifies, 6)
  const impls = calls.claude.filter((r) => r.prompt.includes('機能を実装する担当'))
  assert.match(impls[1].prompt, /デザインシステムの決まりに違反/)
  assert.equal(state.status, 'merged')
})

test('changing the design system itself blocks the merge', async () => {
  const s = setup({ designSystem: true })
  const { deps } = fakeDeps(s, { touch: 'design-system/copy.md' })
  await runLine({ home: s.home, deps })
  assert.equal(loadState(s.fdir, {}).status, 'stopped')
  assert.match(readFileSync(join(s.fdir, 'report.md'), 'utf8'), /design-system\/copy\.md/)
})

test('component candidates from the implementer end up in the report', async () => {
  const s = setup({ designSystem: true })
  const { deps } = fakeDeps(s, { report: '実装しました。\n\n## 部品の候補\n\n- 文字数の表示\n' })
  await runLine({ home: s.home, deps })
  assert.match(readFileSync(join(s.fdir, 'report.md'), 'utf8'), /部品の候補[\s\S]*文字数の表示/)
})

test('the chosen UI mock images go into the branch next to the spec, the scenarios do not', async () => {
  const s = setup()
  mkdirSync(join(s.fdir, 'ui'))
  writeFileSync(join(s.fdir, 'ui', 'chosen.png'), 'png')
  const { deps, calls } = fakeDeps(s)
  let seen = null
  const claude = deps.claude
  deps.claude = async (role) => {
    if (role.prompt.includes('機能を実装する担当')) seen = { ui: existsSync(join(role.cwd, 'docs', 'factory', ID, 'ui', 'chosen.png')), scenarios: existsSync(join(role.cwd, 'docs', 'factory', ID, 'scenarios')) }
    return claude(role)
  }
  await runLine({ home: s.home, deps })
  assert.deepEqual(seen, { ui: true, scenarios: false })
  assert.ok(calls.claude.length > 0)
})

test('a scenario with seed data gets it loaded into the fresh app before each verify run', async () => {
  const s = setup()
  writeFileSync(join(s.fdir, 'scenarios', 'share-02.md'), '---\nid: share-02\ntitle: b\nrequired: false\n---\n## 前提\n```json factory-seed\n{"memos": ["old"]}\n```\n')
  const { deps } = fakeDeps(s)
  const seeded = []
  deps.adapter.seedApp = (o) => seeded.push(o.seed)
  await runLine({ home: s.home, deps })
  // share-02 の 3 回分だけ。share-01 には仕込まない
  assert.deepEqual(seeded, ['{"memos":["old"]}', '{"memos":["old"]}', '{"memos":["old"]}'])
  assert.equal(loadState(s.fdir, {}).status, 'merged')
})
