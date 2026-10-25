import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { featureDir, projectHome } from '../line/paths.js'
import { enqueue, listQueue, readLock } from '../line/queue.js'
import { loadState } from '../line/state.js'
import { runLine } from '../line/line.js'

const ID = '20261018-share-memo'

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// 一時的なリポジトリ（origin は bare）と、工場の置き場所に仕様とシナリオを用意する。
function setup({ protectedPaths = ['**/*.entitlements'], workflows = false, models = {}, designSystem = false, control = { base: false }, quality = { review: false }, ios = {}, satisfaction = {} } = {}) {
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
    JSON.stringify({ type: 'ios', ios: { project: 'App.xcodeproj', scheme: 'App', bundle_id: 'com.example.App', ...ios }, protected_paths: protectedPaths, models, max_rounds: 2, notify: { mac: true, pr_report: true }, control, quality, satisfaction }),
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

// judge: 周（陰性対照は 0）と判定役のプロンプトから、満足かどうかを返す関数。
// tests: 実装役が足すテストのファイル（null なら足さない）。denials: 周ごとに、実装役が拒否された操作。
function fakeDeps(s, { judge = (round) => round >= 1, testsPass = () => true, touch = 'Share.swift', content = null, tests = 'AppTests/ShareTests.swift', ciPasses = true, blocked = () => false, violate = () => false, report = 'implemented', commit = true, write = true, denials = () => [], uiTest = () => ({ ok: true, log: '' }), buildForVerify = () => ({ ok: true }), preflight = () => [] } = {}) {
  const calls = { claude: [], gh: [], notify: [], round: 0, closed: [], verifies: 0, verifyBuilds: [], uiTests: [], preflights: 0 }
  const judgeRuns = (role) => {
    const runs = (role.prompt.match(/^- .*runs\//gm) || []).length
    const ok = judge(calls.round, role.prompt)
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
        try {
          readdirSync(join(s.fdir, 'scenarios'))
          calls.scenariosReadable = true
        } catch {
          calls.scenariosReadable = false
        }
        if (write) {
          mkdirSync(dirname(join(role.cwd, touch)), { recursive: true })
          writeFileSync(join(role.cwd, touch), content ? content(calls.round) : `// round ${calls.round}\n`)
          if (tests) {
            mkdirSync(dirname(join(role.cwd, tests)), { recursive: true })
            writeFileSync(join(role.cwd, tests), `// test round ${calls.round}\n`)
          }
        }
        if (violate(calls.round)) writeFileSync(join(role.cwd, 'Violation.swift'), '// Color.red\n')
        else if (existsSync(join(role.cwd, 'Violation.swift'))) git(role.cwd, 'rm -q Violation.swift')
        if (commit && write) {
          git(role.cwd, 'add -A')
          git(role.cwd, `commit -q -m "round ${calls.round}"`)
        }
        return { result: typeof report === 'function' ? report(calls.round) : report, total_cost_usd: 0.5, usage: { input_tokens: 100, output_tokens: 20 }, permission_denials: denials(calls.round) }
      }
      if (role.prompt.includes('壊す担当')) {
        calls.sabotaged = true
        writeFileSync(join(role.cwd, touch), '// broken\n')
        return { result: '保存されないようにした' }
      }
      if (role.prompt.includes('記録する担当')) {
        calls.verifies += 1
        writeFileSync(join(role.cwd, 'log.md'), 'tapped\n')
        const b = blocked(calls.verifies)
        writeFileSync(join(role.cwd, 'result.json'), JSON.stringify({ completed: !b, blocked_by_tool: b, reason: b ? 'DEVICE_IN_USE' : '' }))
        return { result: '記録しました' }
      }
      if (role.prompt.includes('レビューする担当')) return { result: '- 中・Share.swift:1・名前が短い' }
      return { result: '```json\n' + JSON.stringify(judgeRuns(role)) + '\n```' }
    },
    adapter: {
      udid: () => 'UDID',
      preflight: () => (calls.preflights++, preflight(calls.preflights)),
      commands: () => ({ prebuild: null, build: 'true', test: 'true', buildForTesting: 'true', uiTest: (cls) => `test ${cls}` }),
      buildAndTest: () => (testsPass(calls.round) ? { ok: true } : { ok: false, command: 'xcodebuild test', log: 'FAILED' }),
      buildForVerify: (cmds, cwd) => {
        calls.verifyBuilds.push({ cwd, head: git(cwd, 'rev-parse HEAD').trim(), files: git(cwd, 'ls-files --others --exclude-standard').trim() })
        return buildForVerify(calls.verifyBuilds.length)
      },
      runUiTest: ({ cls, seed }) => {
        calls.uiTests.push({ cls, seed })
        return uiTest(cls, calls.round)
      },
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

const implements_ = (calls) => calls.claude.filter((r) => r.prompt.includes('機能を実装する担当'))

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

  // 合格したシナリオは 1 回だけ流す（2 シナリオ × 1 回の検証と、1 回ごとの判定）
  assert.equal(calls.claude.filter((r) => r.prompt.includes('記録する担当')).length, 2)
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
  const impls = implements_(calls)
  assert.equal(impls.length, 2)
  assert.match(impls[1].prompt, /保存されない/)
  assert.equal(loadState(s.fdir, {}).status, 'merged')
  // 落ちた周は、各シナリオを上限の 3 回まで流し直し、合格した周は 1 回ずつ
  assert.equal(calls.verifies, 2 * 3 + 2)
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
  assert.equal(calls.verifies, 3)
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
  // 1 周目は検証しない（2 シナリオ × 1 回は 2 周目の分だけ）
  assert.equal(calls.verifies, 2)
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
  // share-02 の 1 回分だけ。share-01 には仕込まない
  assert.deepEqual(seeded, ['{"memos":["old"]}'])
  assert.equal(loadState(s.fdir, {}).status, 'merged')
})

test('the line commits what the implementer left uncommitted, so what is verified is what gets merged', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s, { commit: false })
  let testedClean = null
  const buildAndTest = deps.adapter.buildAndTest
  deps.adapter.buildAndTest = (cmds, wt) => {
    testedClean = git(wt, 'status --porcelain') === ''
    return buildAndTest(cmds, wt)
  }
  // マージの命令が出た時点で、push されたブランチの中身を見る（マージのあとブランチは消される）
  let merged = null
  const gh = deps.gh
  deps.gh = (argv, cwd) => {
    if (argv[0] === 'pr' && argv[1] === 'merge') merged = git(join(s.root, 'origin.git'), `ls-tree -r --name-only factory/${ID}`)
    return gh(argv, cwd)
  }
  await runLine({ home: s.home, deps })
  assert.equal(testedClean, true)
  assert.equal(loadState(s.fdir, {}).status, 'merged')
  assert.match(merged, /Share\.swift/)
  assert.ok(calls.gh.some((a) => a.startsWith('pr merge')))
})

test('a round that changes nothing besides the spec is not merged', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s, { write: false })
  await runLine({ home: s.home, deps })
  const state = loadState(s.fdir, {})
  assert.equal(state.status, 'stopped')
  assert.equal(calls.gh.some((a) => a.startsWith('pr merge')), false)
  assert.match(readFileSync(join(s.fdir, 'report.md'), 'utf8'), /実装の変更がない/)
})

test('the branch starts from origin, not from unpushed local commits, even without origin/HEAD', async () => {
  const s = setup()
  // 手元だけのコミット（push していない）
  writeFileSync(join(s.repo, 'Local.txt'), 'not pushed\n')
  git(s.repo, 'add -A')
  git(s.repo, 'commit -q -m local')
  const { deps, calls } = fakeDeps(s)
  let branchFiles = null
  const gh = deps.gh
  deps.gh = (argv, cwd) => {
    if (argv[0] === 'pr' && argv[1] === 'merge') branchFiles = git(join(s.root, 'origin.git'), `ls-tree -r --name-only factory/${ID}`)
    return gh(argv, cwd)
  }
  await runLine({ home: s.home, deps })
  assert.equal(loadState(s.fdir, {}).status, 'merged')
  assert.match(branchFiles, /Share\.swift/)
  assert.doesNotMatch(branchFiles, /Local\.txt/)
  assert.ok(calls.claude.length > 0)
})

test('the seed hook and the factory settings are always protected, whatever the config lists', async () => {
  for (const touch of ['App/FactorySeed.swift', '.factory/seed.md']) {
    const s = setup({ protectedPaths: ['**/*.entitlements'] })
    const { deps, calls } = fakeDeps(s, { touch })
    await runLine({ home: s.home, deps })
    assert.equal(loadState(s.fdir, {}).status, 'stopped', touch)
    assert.equal(calls.gh.some((a) => a.startsWith('pr merge')), false, touch)
    const implement = calls.claude.find((r) => r.prompt.includes('機能を実装する担当'))
    assert.match(implement.prompt, /FactorySeed\.swift/)
  }
})

// ---- 2026-10-20 の改善（陰性対照、SHA、事前確認、再実行、XCUITest、最終関門、品質関門、抜け道、KPI）----

const scenarioFile = (id, { required = false, holdout = false } = {}) => `---\nid: ${id}\ntitle: t\nrequired: ${required}\n${holdout ? 'holdout: true\n' : ''}---\n本文\n`

test('verification builds the committed SHA in a clean checkout, and the merge is pinned to that SHA', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s)
  await runLine({ home: s.home, deps })
  const state = loadState(s.fdir, {})
  assert.equal(state.status, 'merged')
  const sha = state.rounds[0].sha
  assert.match(sha, /^[0-9a-f]{40}$/)
  const [build] = calls.verifyBuilds
  assert.equal(build.head, sha)
  assert.notEqual(build.cwd, implements_(calls)[0].cwd)
  assert.ok(calls.gh.some((a) => a.startsWith('pr merge') && a.includes(`--match-head-commit ${sha}`)))
  // 検証用のチェックアウトは片づける
  assert.equal(existsSync(build.cwd), false)
})

test('if the branch moves after verification, nothing is merged', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s)
  deps.adapter.shutdown = () => {
    const wt = implements_(calls)[0].cwd
    writeFileSync(join(wt, 'Late.swift'), '// pushed after verification\n')
    git(wt, 'add -A')
    git(wt, 'commit -q -m late')
  }
  await runLine({ home: s.home, deps })
  const state = loadState(s.fdir, {})
  assert.equal(state.status, 'error')
  assert.match(state.error, /検証したコミット/)
  assert.equal(calls.gh.some((a) => a.startsWith('pr merge')), false)
})

test('a failing preflight is retried once, and a second failure stops before any model is called', async () => {
  const once = setup()
  const a = fakeDeps(once, { preflight: (n) => (n === 1 ? ['agent-device がない'] : []) })
  await runLine({ home: once.home, deps: a.deps })
  assert.equal(loadState(once.fdir, {}).status, 'merged')

  const twice = setup()
  const b = fakeDeps(twice, { preflight: () => ['agent-device がない'] })
  await runLine({ home: twice.home, deps: b.deps })
  const state = loadState(twice.fdir, {})
  assert.equal(state.status, 'error')
  assert.match(state.error, /事前確認.*agent-device/)
  assert.equal(b.calls.claude.length, 0)
})

test('commands the implementer was denied are passed on as tool notes, apart from the product symptoms', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s, { judge: (round) => round >= 2, denials: (round) => (round === 1 ? [{ tool_name: 'Bash', tool_input: { command: 'cat > A.swift <<EOF\nx\nEOF' } }] : []) })
  await runLine({ home: s.home, deps })
  const [first, second] = implements_(calls)
  assert.match(first.prompt, /道具の注意[\s\S]*なし/)
  assert.match(second.prompt, /道具の注意[\s\S]*Bash: cat > A\.swift <<EOF/)
})

test('a scenario whose XCUITest passes needs no verify agent, a failing one falls back to it', async () => {
  const s = setup({ ios: { ui_tests: { target: 'FactoryUITests', dir: 'FactoryUITests' } } })
  writeFileSync(join(s.fdir, 'scenarios', 'share-01.swift'), 'import XCTest\nfinal class Share01Tests: XCTestCase {}\n')
  writeFileSync(join(s.fdir, 'scenarios', 'share-02.swift'), 'import XCTest\nfinal class Share02Tests: XCTestCase {}\n')
  const { deps, calls } = fakeDeps(s, { uiTest: (cls) => ({ ok: cls === 'Share01Tests', log: '' }) })
  await runLine({ home: s.home, deps })
  const state = loadState(s.fdir, {})
  assert.equal(state.status, 'merged')
  assert.deepEqual(calls.uiTests.map((t) => t.cls), ['Share01Tests', 'Share02Tests'])
  // share-02 だけ検証役が操作した
  const verified = calls.claude.filter((r) => r.prompt.includes('記録する担当')).map((r) => /scenarios\/([\w-]+)\.md/.exec(r.prompt)[1])
  assert.deepEqual(verified, ['share-02'])
  assert.equal(state.rounds[0].xcuitest, 1)
  // テストのファイルは検証用のチェックアウトにだけ入り、実装役のブランチには入らない
  assert.match(calls.verifyBuilds[0].files, /FactoryUITests\/Share01Tests\.swift/)
  const impl = implements_(calls)[0]
  assert.match(impl.prompt, /FactoryUITests\/\*\*/)
})

test('scenario XCUITests that do not compile are dropped and the verify agent checks everything', async () => {
  const s = setup({ ios: { ui_tests: { target: 'FactoryUITests', dir: 'FactoryUITests' } } })
  writeFileSync(join(s.fdir, 'scenarios', 'share-01.swift'), 'import XCTest\nfinal class Share01Tests: XCTestCase { broken }\n')
  const { deps, calls } = fakeDeps(s, { buildForVerify: (n) => ({ ok: n !== 1, command: 'xcodebuild build-for-testing', log: 'error: broken' }) })
  await runLine({ home: s.home, deps })
  const state = loadState(s.fdir, {})
  assert.equal(state.status, 'merged')
  assert.equal(calls.uiTests.length, 0)
  assert.equal(calls.verifies, 2)
  assert.equal(calls.verifyBuilds[1].files, '')
  assert.equal(state.rounds[0].uiTestBuild, 'failed')
  // コンパイルの失敗は実装役の症状にならない
  assert.doesNotMatch(state.symptoms.join('\n'), /broken/)
})

test('holdout scenarios are run only once the others pass, and their failure stops the line without symptoms', async () => {
  const s = setup()
  writeFileSync(join(s.fdir, 'scenarios', 'share-03.md'), scenarioFile('share-03', { holdout: true }).replace('本文', '最終関門だけの観点'))
  const { deps, calls } = fakeDeps(s, { judge: (round, prompt) => round >= 1 && !prompt.includes('share-03') })
  await runLine({ home: s.home, deps })
  const state = loadState(s.fdir, {})
  assert.equal(state.status, 'stopped')
  // 周を重ねない（最終関門の症状を返さない）
  assert.equal(implements_(calls).length, 1)
  assert.equal(state.rounds[0].holdout.score, 0)
  assert.doesNotMatch(state.symptoms.join('\n'), /保存されない/)
  assert.match(calls.gh.find((a) => a.startsWith('pr create')), /--draft/)
  assert.match(readFileSync(join(s.fdir, 'report.md'), 'utf8'), /最終関門のシナリオが不合格/)
})

test('holdout scenarios are not run in a round whose other scenarios fail', async () => {
  const s = setup()
  writeFileSync(join(s.fdir, 'scenarios', 'share-03.md'), scenarioFile('share-03', { holdout: true }))
  const { deps, calls } = fakeDeps(s, { judge: (round) => round >= 2 })
  await runLine({ home: s.home, deps })
  const judged = calls.claude.filter((r) => r.prompt.includes('採点する担当'))
  const holdoutJudged = judged.filter((r) => r.prompt.includes('share-03'))
  // 1 周目は開発用だけ。2 周目に開発用が合格してから 1 回
  assert.equal(holdoutJudged.length, 1)
  assert.match(holdoutJudged[0].prompt, /runs\/2-holdout\//)
  assert.equal(loadState(s.fdir, {}).status, 'merged')
})

test('the negative control stops the feature when the current app already passes the scenarios', async () => {
  const s = setup({ control: { base: true } })
  const { deps, calls } = fakeDeps(s, { judge: () => true })
  await runLine({ home: s.home, deps })
  const state = loadState(s.fdir, {})
  assert.equal(state.status, 'stopped')
  assert.equal(implements_(calls).length, 0)
  assert.equal(calls.gh.length, 0)
  assert.equal(state.control.score, 1)
  assert.match(readFileSync(join(s.fdir, 'report.md'), 'utf8'), /シナリオが機能を区別できていない/)
  assert.match(calls.notify.at(-1).title, /止まりました/)
})

test('the negative control runs once before implementing and then the line goes on', async () => {
  const s = setup({ control: { base: true } })
  const { deps, calls } = fakeDeps(s)
  await runLine({ home: s.home, deps })
  const state = loadState(s.fdir, {})
  assert.equal(state.status, 'merged')
  assert.equal(state.control.score, 0)
  // 陰性対照は 1 回ずつ（落ちても流し直さない）+ 1 周目
  assert.equal(calls.verifies, 2 + 2)
  assert.match(readFileSync(join(s.fdir, 'report.md'), 'utf8'), /陰性対照/)
})

test('with the saboteur on, a broken app that still passes blocks the merge, one that fails lets it through', async () => {
  const caught = setup({ control: { base: false, mutant: true } })
  const a = fakeDeps(caught, { judge: (round, prompt) => round >= 1 && !prompt.includes('-mutant/') })
  await runLine({ home: caught.home, deps: a.deps })
  assert.equal(a.calls.sabotaged, true)
  const ok = loadState(caught.fdir, {})
  assert.equal(ok.status, 'merged')
  assert.equal(ok.rounds[0].mutant.detected, true)
  // 壊したコミットはマージされたブランチに入らない
  assert.notEqual(ok.rounds[0].mutant.sha, ok.rounds[0].sha)

  const missed = setup({ control: { base: false, mutant: true } })
  const b = fakeDeps(missed)
  await runLine({ home: missed.home, deps: b.deps })
  const state = loadState(missed.fdir, {})
  assert.equal(state.status, 'stopped')
  assert.equal(state.rounds[0].mutant.detected, false)
  assert.equal(b.calls.gh.some((x) => x.startsWith('pr merge')), false)
  assert.match(readFileSync(join(missed.fdir, 'report.md'), 'utf8'), /わざと壊したアプリも必須シナリオに合格した/)
})

test('a round without a test file is sent back before verification', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s, { tests: null })
  await runLine({ home: s.home, deps })
  const state = loadState(s.fdir, {})
  assert.equal(state.status, 'stopped')
  assert.equal(calls.verifies, 0)
  assert.match(implements_(calls)[1].prompt, /テストが足されていない/)
})

test('a lint failure is a symptom for the next round', async () => {
  const s = setup({ quality: { review: false, lint: 'node -e "process.exit(1)"' } })
  const { deps, calls } = fakeDeps(s)
  await runLine({ home: s.home, deps })
  assert.equal(loadState(s.fdir, {}).rounds[0].lint, false)
  assert.match(implements_(calls)[1].prompt, /lint が通らない/)
})

test('a change larger than the limit is left for a person as a draft, without another round', async () => {
  const s = setup({ quality: { review: false, max_changed_lines: 1 } })
  const { deps, calls } = fakeDeps(s)
  await runLine({ home: s.home, deps })
  const state = loadState(s.fdir, {})
  assert.equal(state.status, 'stopped')
  assert.equal(implements_(calls).length, 1)
  assert.match(calls.gh.find((a) => a.startsWith('pr create')), /--draft/)
  assert.match(readFileSync(join(s.fdir, 'report.md'), 'utf8'), /上限 1 行を超える/)
})

test('a round that adds a build script is thrown away and never reaches the branch', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s, { touch: 'project.yml', content: (round) => (round === 1 ? 'targets:\n  App:\n    preBuildScripts:\n      - script: cat ~/.factory/x\n' : 'name: App\n') })
  let merged = null
  const gh = deps.gh
  deps.gh = (argv, cwd) => {
    if (argv[0] === 'pr' && argv[1] === 'merge') merged = git(join(s.root, 'origin.git'), `log --format=%s factory/${ID}`)
    return gh(argv, cwd)
  }
  await runLine({ home: s.home, deps })
  const state = loadState(s.fdir, {})
  assert.equal(state.status, 'merged')
  assert.equal(state.rounds[0].discarded, true)
  assert.match(implements_(calls)[1].prompt, /スクリプトを足したので、この周の変更はすべて捨てた/)
  assert.doesNotMatch(merged, /round 1/)
  assert.match(merged, /round 2/)
})

test('the scenarios are locked while the implementer runs, and a leaked canary stops the feature', async () => {
  const s = setup()
  const { deps, calls } = fakeDeps(s, { report: () => `memo: ${loadState(s.fdir, {}).canary}` })
  await runLine({ home: s.home, deps })
  assert.equal(calls.scenariosReadable, false)
  const state = loadState(s.fdir, {})
  assert.equal(state.status, 'error')
  assert.match(state.error, /漏れました/)
  assert.equal(calls.gh.length, 0)
  // 目印はシナリオに埋めてあり、ロックは外れている
  assert.match(readFileSync(join(s.fdir, 'scenarios', 'share-01.md'), 'utf8'), /factory-canary: [0-9a-f]+/)
})

test('a review from another model goes into the report and does not block the merge', async () => {
  const s = setup({ quality: { review: true } })
  const { deps, calls } = fakeDeps(s)
  await runLine({ home: s.home, deps })
  assert.equal(loadState(s.fdir, {}).status, 'merged')
  const review = calls.claude.find((r) => r.prompt.includes('レビューする担当'))
  assert.equal(review.model, 'opus')
  assert.ok(!review.allowedTools.some((t) => /^(Edit|Write)/.test(t)))
  assert.equal(review.hide, s.home)
  assert.match(readFileSync(join(s.fdir, 'report.md'), 'utf8'), /コードのレビュー[\s\S]*名前が短い/)
})

test('steps and calls are recorded as factory metrics and summarized in the report', async () => {
  const s = setup()
  const { deps } = fakeDeps(s)
  await runLine({ home: s.home, deps })
  const lines = readFileSync(join(s.fdir, 'metrics.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.some((l) => l.type === 'step' && l.step === 'verify'))
  const impl = lines.find((l) => l.type === 'call' && l.role === 'implement')
  assert.equal(impl.cost_usd, 0.5)
  assert.equal(impl.input_tokens, 100)
  assert.equal(lines.filter((l) => l.type === 'call' && l.role === 'verify').length, 2)
  assert.match(readFileSync(join(s.fdir, 'report.md'), 'utf8'), /工場の記録[\s\S]*\$0\.50/)
})

test('the verify commands are made after the checkout exists, so a project.yml there is seen', async () => {
  const s = setup()
  const { deps } = fakeDeps(s)
  const seen = []
  const commands = deps.adapter.commands
  deps.adapter.commands = (o) => (seen.push({ repo: o.repo, exists: existsSync(o.repo) }), commands(o))
  await runLine({ home: s.home, deps })
  const verify = seen.filter((c) => c.repo.endsWith('-verify'))
  assert.ok(verify.length >= 1)
  assert.ok(verify.every((c) => c.exists))
})

// 8 回目の試運転: 今のアプリで落ちる XCUITest を、陰性対照のたびに検証役で確かめ直すと遅い
test('in the negative control a failing XCUITest counts as a failure without the verify agent, a timed-out one still falls back', async () => {
  const s = setup({ control: { base: true }, ios: { ui_tests: { target: 'FactoryUITests', dir: 'FactoryUITests' } } })
  writeFileSync(join(s.fdir, 'scenarios', 'share-01.swift'), 'import XCTest\nfinal class Share01Tests: XCTestCase {}\n')
  writeFileSync(join(s.fdir, 'scenarios', 'share-02.swift'), 'import XCTest\nfinal class Share02Tests: XCTestCase {}\n')
  // 実装の前（round 0）は落ちる。share-02 は打ち切りになる。実装のあとは通る
  const uiTest = (cls, round) => (round >= 1 ? { ok: true, log: '' } : { ok: false, timedOut: cls === 'Share02Tests', log: '' })
  const { deps, calls } = fakeDeps(s, { uiTest, judge: () => false })
  await runLine({ home: s.home, deps })
  const state = loadState(s.fdir, {})
  assert.equal(state.status, 'merged')
  assert.equal(state.control.score, 0)
  const verified = calls.claude.filter((r) => r.prompt.includes('記録する担当')).map((r) => /scenarios\/([\w-]+)\.md/.exec(r.prompt)[1])
  assert.deepEqual(verified, ['share-02'])
})
