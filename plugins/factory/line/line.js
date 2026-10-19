// ライン本体。待ち行列から機能を 1 つずつ取り出し、実装 → テスト → 検証 → 判定 → マージ判定 を進める。
// 手順が決まっている工程はこのスクリプトが行い、モデルを呼ぶのは実装・検証・判定だけにする。
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ios from './adapters/ios.js'
import { runClaude, withUsageWait } from './claude.js'
import { isCodex, runCodex } from './codex.js'
import { loadConfig } from './config.js'
import { loadDesignSystem, parseComponentCandidates } from './design.js'
import { originBase } from './git.js'
import { parseSeed } from './seed.js'
import { decideMerge, protectedChanges, summarize } from './gate.js'
import { factoryHome, featureDir, projectHome, projectSlug } from './paths.js'
import { parseJudgement, render } from './prompts.js'
import { acquireLock, dequeue, releaseLock } from './queue.js'
import { loadState, saveState } from './state.js'

const IMPLEMENT_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(xcodebuild *)', 'Bash(xcodegen *)', 'Bash(swift *)', 'Bash(ls *)',
  'Bash(git add *)', 'Bash(git commit *)', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)',
]
const UNSANDBOXED = ['xcodebuild *', 'xcodegen *']
// 設定に関係なく、実装役に変えさせないもの: 工場の設定と、前提のデータを仕込む口（init で足すもの）
const ALWAYS_PROTECTED = ['.factory/**', '**/FactorySeed.swift']
const JUDGE_SCHEMA = fileURLToPath(new URL('./prompts/judge.schema.json', import.meta.url))

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') }
}

function shell(cmd, cwd) {
  return sh('/bin/sh', ['-c', cmd], cwd)
}

// 実装役に渡す、デザインシステムの使い方。
function designRules(ds) {
  return [
    'このアプリにはデザインシステムがある。画面は、次の文書に書かれた部品とトークンだけで作ること。色・文字の大きさ・余白・角丸を直接書かない。',
    '',
    list(ds.docs),
    '',
    'デザインシステムにない部品が必要なら、既存の部品とトークンを組み合わせて作り、最後の報告に「## 部品の候補」という見出しで箇条書きにすること（デザインシステム自体は変えない）。',
    ds.check ? `終わったら \`${ds.check}\` で違反がないことを確かめること。` : '',
  ].join('\n')
}

function git(cwd, ...args) {
  const r = sh('git', args, cwd)
  if (!r.ok) throw new Error(`git ${args.join(' ')} が失敗しました: ${r.out}`)
  return r.out.trim()
}

export function defaultDeps() {
  return {
    workRoot: join(homedir(), 'Library', 'Caches', 'factory'),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
    claude: (role) => runClaude(role),
    codex: (role) => runCodex(role),
    adapter: {
      udid: (config) => ios.resolveDevice(ios.listDevices(), config.ios.device),
      commands: ios.commands,
      buildAndTest: ios.buildAndTest,
      findApp: ios.findApp,
      resetApp: ios.resetApp,
      shutdown: ios.shutdown,
      closeSession: ios.closeSession,
      seedApp: ios.seedApp,
    },
    gh: (args, cwd) => sh('gh', args, cwd),
    notify: (title, body) => sh('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]),
  }
}

// シナリオのファイル（先頭に id と required を書いた Markdown）を読む。
export function readScenarios(dir) {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .sort()
    .map((name) => {
      const text = readFileSync(join(dir, name), 'utf8')
      const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
      const id = /^id:\s*(.+)$/m.exec(head)?.[1].trim() ?? name.replace(/\.md$/, '')
      return { id, path: join(dir, name), required: /^required:\s*true\s*$/m.test(head), seed: parseSeed(text, id) }
    })
}

// 検証役が書く result.json。書かれていなければ、検証役が最後まで動けなかったとみなす。
function readVerifyResult(out) {
  try {
    return JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'))
  } catch {
    return { completed: false, blocked_by_tool: true, reason: 'result.json がない' }
  }
}

function list(items) {
  return items.length ? items.map((s) => `- ${s}`).join('\n') : 'なし'
}

function report({ id, state, config, decision, prUrl }) {
  const rows = state.rounds.map((r) => `| ${r.round} | ${r.noChanges ? '実装なし' : r.tests ? '通過' : '失敗'} | ${r.score === null ? '—' : `${(r.score * 100).toFixed(1)}%`} | ${r.requiredFailures?.join(', ') || '—'} |`)
  return [
    `# factory レポート: ${id}`,
    '',
    decision.merge ? '自動マージの条件をすべて満たしました。' : `自動マージしませんでした（${config.max_rounds} 周の上限まで試しました）。`,
    prUrl ? `\nPR: ${prUrl}` : '',
    '',
    '| 周 | ビルドと全テスト | 満足度 | 不合格の必須シナリオ |',
    '| - | - | - | - |',
    ...rows,
    '',
    decision.reasons.length ? `## 満たせなかった条件\n\n${list(decision.reasons)}\n` : '',
    state.symptoms.length ? `## 最後の周で見つかった症状\n\n${list(state.symptoms)}\n` : '',
    state.candidates?.length ? `## 部品の候補\n\nデザインシステムにない部品を、既存の部品とトークンで組みました。部品にするかは \`/design-system:update\` で決めてください。\n\n${list(state.candidates)}\n` : '',
  ].join('\n')
}

// 設定のモデル名が codex で始まる役は Codex に、それ以外は Claude に回す。
async function call(deps, state, fdir, role) {
  return withUsageWait(() => (isCodex(role.model) ? deps.codex(role) : deps.claude(role)), {
    now: deps.now,
    sleep: deps.sleep,
    onPause: (until) => {
      saveState(fdir, { ...state, status: 'paused', paused_until: until })
      deps.log(`利用上限のため ${new Date(until).toISOString()} まで一時停止します`)
    },
  })
}

export async function runFeature({ entry, home, deps }) {
  const { repo, id } = entry
  const config = loadConfig(repo)
  const fdir = featureDir(projectHome(repo, home), id)
  const scenarios = readScenarios(join(fdir, 'scenarios'))
  const work = join(deps.workRoot, projectSlug(repo))
  const wt = join(work, id)
  const derived = join(work, `${id}-derived`)
  const branch = `factory/${id}`
  const specRel = join('docs', 'factory', id, 'spec.md')
  let state = { ...loadState(fdir, entry), status: 'running', paused_until: null }
  // 工程が変わるたびに保存し、ログにも 1 行残す。
  let logged = `${state.round}-${state.step}`
  const save = () => {
    saveState(fdir, state)
    const now = `${state.round}-${state.step}`
    if (now !== logged) deps.log(`${id}: ${state.round} 周目 ${state.step}`)
    logged = now
  }

  if (!existsSync(wt)) {
    mkdirSync(work, { recursive: true })
    sh('git', ['fetch', '-q', 'origin'], repo)
    git(repo, 'worktree', 'add', '-q', '-b', branch, wt, originBase(repo))
    mkdirSync(join(wt, 'docs', 'factory', id), { recursive: true })
    copyFileSync(join(fdir, 'spec.md'), join(wt, specRel))
    // UI 案の段階で選んだ画面の画像も、仕様と同じフォルダに入れる（シナリオは入れない）。
    if (existsSync(join(fdir, 'ui'))) cpSync(join(fdir, 'ui'), join(wt, 'docs', 'factory', id, 'ui'), { recursive: true })
    git(wt, 'add', join('docs', 'factory', id))
    git(wt, 'commit', '-q', '-m', `Add factory spec for ${id}`)
  }
  const base = git(wt, 'merge-base', 'HEAD', originBase(wt))
  const specDir = join('docs', 'factory', id) + '/'
  // 仕様（docs/factory/<id>/）のほかに変わったファイル
  const codeChanges = () => git(wt, 'diff', '--name-only', base, 'HEAD').split('\n').filter((f) => f && !f.startsWith(specDir))
  const ds = loadDesignSystem(wt)
  const protectedPaths = [...new Set([...ALWAYS_PROTECTED, ...config.protected_paths, ...(ds?.protected_paths ?? [])])]
  const udid = deps.adapter.udid(config)
  const cmds = deps.adapter.commands({ config, repo: wt, udid, derived })
  let decision = { merge: false, reasons: [] }

  deps.log(`${id}: ${state.round} 周目 ${state.step} から始めます`)
  while (state.status === 'running') {
    const round = state.round

    if (state.step === 'implement') {
      const prompt = render('implement', {
        spec: specRel,
        round,
        symptoms: list(state.symptoms),
        build: [cmds.prebuild, cmds.build].filter(Boolean).join(' && '),
        test: [cmds.prebuild, cmds.test].filter(Boolean).join(' && '),
        protected: list(protectedPaths),
        design: ds ? designRules(ds) : 'なし（このアプリにはデザインシステムがない。今ある画面の書き方に合わせる）',
      })
      const res = await call(deps, state, fdir, { cwd: wt, model: config.models.implement, allowedTools: IMPLEMENT_TOOLS, hide: home, unsandboxed: UNSANDBOXED, prompt })
      const candidates = [...new Set([...(state.candidates ?? []), ...parseComponentCandidates(String(res.result ?? ''))])]
      // 実装役がコミットし忘れても、検証するものとマージするものがずれないよう、ラインがコミットする
      if (git(wt, 'status', '--porcelain')) {
        git(wt, 'add', '-A')
        git(wt, 'commit', '-q', '-m', `Implement ${id} (factory round ${round})`)
      }
      if (codeChanges().length === 0) {
        // 仕様のほかに何も変わっていなければ、テストも検証もせずに次へ
        state = { ...state, step: 'decide', candidates, rounds: [...state.rounds.filter((r) => r.round !== round), { round, tests: null, design: null, score: null, requiredFailures: [], noChanges: true }] }
      } else {
        state = { ...state, step: 'test', candidates }
      }
      save()
    }

    if (state.step === 'test') {
      const t = deps.adapter.buildAndTest(cmds, wt)
      // デザインシステムのチェックは、ビルドと全テストが通ったあとに行う。違反があれば、その周は検証しない。
      const d = t.ok && ds?.check ? shell(ds.check, wt) : null
      const entry = { round, tests: t.ok, design: d ? d.ok : null, score: null, requiredFailures: [], testLog: t.ok ? null : `${t.command}\n${t.log}`, designLog: d && !d.ok ? d.out.slice(-8000) : null }
      state = { ...state, step: t.ok && d?.ok !== false ? 'verify' : 'decide', rounds: [...state.rounds.filter((r) => r.round !== round), entry] }
      save()
    }

    if (state.step === 'verify') {
      const app = deps.adapter.findApp(derived)
      for (const sc of scenarios) {
        for (let run = 1; run <= config.satisfaction.runs_per_scenario; run++) {
          const out = join(fdir, 'runs', String(round), sc.id, String(run))
          mkdirSync(out, { recursive: true })
          const session = `factory-${id}-${round}-${sc.id}-${run}`.slice(0, 80)
          // 道具の都合（端末が使用中、権限など）で操作できなかった実行は、アプリの不具合ではない。
          // 1 回だけやり直し、それでもだめなら工場のエラーとして止め、実装役には何も渡さない。
          for (let attempt = 1; ; attempt++) {
            deps.adapter.closeSession(session)
            deps.adapter.resetApp({ udid, bundleId: config.ios.bundle_id, app })
            // 前提のデータがあれば、入れ直したアプリに仕込んでから検証役に渡す
            if (sc.seed) deps.adapter.seedApp({ udid, bundleId: config.ios.bundle_id, seed: sc.seed })
            await call(deps, state, fdir, ios.verifyRole({ config, udid, scenario: sc.path, scenarioDir: join(fdir, 'scenarios'), out, session }))
            deps.adapter.closeSession(session)
            const result = readVerifyResult(out)
            if (!result.blocked_by_tool) break
            if (attempt === 2) throw new Error(`検証の道具が動きませんでした（${sc.id} ${run} 回目）: ${result.reason}`)
            deps.log(`${id}: ${sc.id} ${run} 回目は道具の都合で操作できなかったので、やり直します（${result.reason}）`)
          }
        }
      }
      deps.adapter.shutdown(udid)
      state = { ...state, step: 'judge' }
      save()
    }

    if (state.step === 'judge') {
      const runs = []
      for (const sc of scenarios) {
        const dirs = Array.from({ length: config.satisfaction.runs_per_scenario }, (_, i) => join(fdir, 'runs', String(round), sc.id, String(i + 1)))
        const prompt = render('judge', { scenario: sc.path, runs: list(dirs) })
        const model = config.models.judge
        // Codex は読むだけのサンドボックスで動かし、答えの形をスキーマで強制する。
        const role = isCodex(model) ? { cwd: fdir, model, sandbox: 'read-only', schema: JUDGE_SCHEMA, prompt } : { cwd: fdir, model, allowedTools: ['Read', 'Glob'], prompt }
        const res = await call(deps, state, fdir, role)
        for (const j of parseJudgement(res.result, dirs.length)) runs.push({ ...j, scenario: sc.id, required: sc.required })
      }
      mkdirSync(join(fdir, 'judgements'), { recursive: true })
      writeFileSync(join(fdir, 'judgements', `${round}.json`), JSON.stringify(runs, null, 2))
      const s = summarize(runs)
      state = { ...state, step: 'decide', symptoms: s.symptoms, rounds: state.rounds.map((r) => (r.round === round ? { ...r, score: s.score, requiredFailures: s.requiredFailures } : r)) }
      save()
    }

    if (state.step === 'decide') {
      const r = state.rounds.find((x) => x.round === round)
      const changed = git(wt, 'diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean)
      const codeChanged = codeChanges().length > 0
      const protectedHits = protectedChanges(changed, protectedPaths)
      decision = decideMerge({
        summary: { score: r.score ?? 0, requiredFailures: r.requiredFailures },
        threshold: config.satisfaction.threshold,
        testsPassed: r.tests === true,
        codeChanged,
        designPassed: r.design === null ? undefined : r.design,
        ci: 'none',
        protectedHits,
      })
      const symptoms = [
        ...(r.noChanges ? ['実装の変更がない（仕様のほかに、変わったファイルがない）。仕様どおりにアプリのコードを変えること'] : []),
        ...(r.tests === false ? [`ビルドか全テストが通らない:\n${r.testLog}`] : []),
        ...(r.design === false ? [`デザインシステムの決まりに違反している（\`${ds.check}\` の結果）:\n${r.designLog}`] : []),
        ...(protectedHits.length ? [`変更してはいけないファイルを変更した: ${protectedHits.join(', ')}`] : []),
        ...state.symptoms,
      ]
      if (decision.merge) state = { ...state, step: 'merge' }
      else if (round < config.max_rounds) state = { ...state, round: round + 1, step: 'implement', symptoms }
      else state = { ...state, step: 'stop', symptoms }
      save()
    }

    if (state.step === 'merge' || state.step === 'stop') {
      const merging = state.step === 'merge'
      git(wt, 'push', '-q', '-u', 'origin', branch)
      const body = report({ id, state, config, decision })
      writeFileSync(join(fdir, 'report.md'), body)
      if (!state.pr) {
        const create = deps.gh(['pr', 'create', '--head', branch, '--title', `factory: ${id}`, '--body', `仕様: \`${specRel}\``, ...(merging ? [] : ['--draft'])], wt)
        if (!create.ok) throw new Error(`PR を作れませんでした: ${create.out}`)
        state = { ...state, pr: create.out.trim().split('\n').pop() }
        save()
      }
      const prUrl = state.pr
      if (config.notify.pr_report) deps.gh(['pr', 'comment', prUrl, '--body', body], wt)
      if (merging) {
        const ci = existsSync(join(wt, '.github', 'workflows')) ? await waitForCi(deps, prUrl, wt) : 'none'
        if (ci !== 'none' && ci !== 'success') {
          state = { ...state, step: 'stop', symptoms: [`GitHub の CI が ${ci}`] }
          save()
          continue
        }
        // --delete-branch は手元のチェックアウトを既定のブランチに切り替えようとし、worktree では失敗するので付けない。
        const m = deps.gh(['pr', 'merge', prUrl, '--squash'], wt)
        if (!m.ok) {
          // マージ自体は GitHub で済んでいて、そのあとで失敗することがある。やり直したときもここに来る。
          const v = deps.gh(['pr', 'view', prUrl, '--json', 'state', '--jq', '.state'], wt)
          if (v.out.trim() !== 'MERGED') throw new Error(`マージに失敗しました: ${m.out}`)
        }
        sh('git', ['push', '-q', 'origin', '--delete', branch], wt)
      }
      state = { ...state, status: merging ? 'merged' : 'stopped', step: 'done' }
      save()
      writeFileSync(join(fdir, 'report.md'), report({ id, state, config, decision, prUrl }))
      if (config.notify.mac) deps.notify(merging ? `factory: ${id} をマージしました` : `factory: ${id} で止まりました`, merging ? prUrl : `Draft PR: ${prUrl}`)
    }
  }

  if (state.status === 'merged') {
    sh('git', ['worktree', 'remove', '--force', wt], repo)
    sh('git', ['branch', '-D', branch], repo)
  }
  return state
}

// PR を作った直後はチェックがまだ登録されていないことがあるので、少し待ってから見る。
async function waitForCi(deps, prUrl, cwd) {
  await deps.sleep(20_000)
  const r = deps.gh(['pr', 'checks', prUrl, '--watch', '--fail-fast'], cwd)
  if (/no checks reported/i.test(r.out)) return 'none'
  return r.ok ? 'success' : 'failure'
}

// ロックを取れたら、待ち行列が空になるまで流す。取れなければ、ほかのラインが動いている。
export async function runLine({ home = factoryHome(), deps = defaultDeps() } = {}) {
  if (!acquireLock(home)) return deps.log('ほかのラインが動いているので終わります')
  try {
    for (let entry = dequeue(home); entry; entry = dequeue(home)) {
      try {
        await runFeature({ entry, home, deps })
      } catch (e) {
        deps.log(`${entry.id}: ${e.stack || e.message}`)
        try {
          const fdir = featureDir(projectHome(entry.repo, home), entry.id)
          saveState(fdir, { ...loadState(fdir, entry), status: 'error', error: String(e.message) })
        } catch {}
        deps.notify(`factory: ${entry.id} でエラー`, String(e.message).slice(0, 200))
      }
    }
  } finally {
    releaseLock(home)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runLine()
