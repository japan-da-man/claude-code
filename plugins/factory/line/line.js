// ライン本体。待ち行列から機能を 1 つずつ取り出し、
// 事前確認 → 陰性対照 → 実装 → テスト → 検証 → 最終関門 →（破壊役）→ マージ判定 を進める。
// 手順が決まっている工程はこのスクリプトが行い、モデルを呼ぶのは実装・検証・判定・破壊・レビューだけにする。
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ios from './adapters/ios.js'
import { runClaude, withUsageWait } from './claude.js'
import { isCodex, runCodex } from './codex.js'
import { loadConfig } from './config.js'
import { loadDesignSystem, parseComponentCandidates } from './design.js'
import { originBase } from './git.js'
import { buildScriptChanges, changedLines, decideMerge, isTestFile, protectedChanges, summarize } from './gate.js'
import { callUsage, describeDenial, metricsTable, readMetrics, record, summarizeMetrics } from './metrics.js'
import { parseSeed } from './seed.js'
import { factoryHome, featureDir, projectHome, projectSlug } from './paths.js'
import { parseJudgement, render } from './prompts.js'
import { acquireLock, dequeue, releaseLock } from './queue.js'
import { loadState, saveState } from './state.js'

const IMPLEMENT_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(xcodebuild *)', 'Bash(xcodegen *)', 'Bash(swift *)', 'Bash(ls *)',
  'Bash(git add *)', 'Bash(git commit *)', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)',
]
const SABOTAGE_TOOLS = ['Read', 'Edit', 'Glob', 'Grep']
const REVIEW_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)']
const UNSANDBOXED = ['xcodebuild *', 'xcodegen *']
// 設定に関係なく、実装役に変えさせないもの: 工場の設定と、前提のデータを仕込む口（init で足すもの）
const ALWAYS_PROTECTED = ['.factory/**', '**/FactorySeed.swift']
const JUDGE_SCHEMA = fileURLToPath(new URL('./prompts/judge.schema.json', import.meta.url))
const CANARY = /factory-canary: ([0-9a-f]+)/

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
      preflight: ios.preflight,
      commands: ios.commands,
      buildAndTest: ios.buildAndTest,
      buildForVerify: ios.buildForVerify,
      runUiTest: ios.runUiTest,
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

// シナリオのファイル（先頭に id・required・holdout を書いた Markdown）を読む。
// 同じ名前の .swift があれば、それはシナリオの XCUITest（期待する結果をすべて機械で確かめられるときだけ作成役が書く）。
export function readScenarios(dir) {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .sort()
    .map((name) => {
      const text = readFileSync(join(dir, name), 'utf8')
      const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
      const id = /^id:\s*(.+)$/m.exec(head)?.[1].trim() ?? name.replace(/\.md$/, '')
      const swift = join(dir, name.replace(/\.md$/, '.swift'))
      return {
        id,
        path: join(dir, name),
        required: /^required:\s*true\s*$/m.test(head),
        holdout: /^holdout:\s*true\s*$/m.test(head),
        seed: parseSeed(text, id),
        uiTest: existsSync(swift) ? swift : null,
      }
    })
}

// シナリオのファイルに目印の文字列（カナリア）を埋める。実装役の出力や差分にこれが出たら、シナリオが漏れている。
export function plantCanary(dir, canary) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name)
    const comment = name.endsWith('.md') ? `<!-- factory-canary: ${canary} -->` : name.endsWith('.swift') ? `// factory-canary: ${canary}` : null
    if (!comment) continue
    const text = readFileSync(file, 'utf8')
    if (CANARY.test(text)) continue
    appendFileSync(file, `${text.endsWith('\n') ? '' : '\n'}${comment}\n`)
  }
}

function existingCanary(dir) {
  for (const name of readdirSync(dir)) {
    const m = /\.(md|swift)$/.test(name) && CANARY.exec(readFileSync(join(dir, name), 'utf8'))
    if (m) return m[1]
  }
  return null
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

const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`)

function roundRow(r) {
  const build = r.discarded ? '捨てた' : r.noChanges ? '実装なし' : r.tests === null ? '—' : r.tests ? '通過' : '失敗'
  return `| ${r.round} | ${r.sha ? `\`${r.sha.slice(0, 7)}\`` : '—'} | ${build} | ${pct(r.score)} | ${r.xcuitest ?? 0} | ${pct(r.holdout?.score)} | ${r.requiredFailures?.join(', ') || '—'} |`
}

function report({ id, state, config, decision, prUrl, metrics }) {
  const last = state.rounds.at(-1)
  return [
    `# factory レポート: ${id}`,
    '',
    decision.merge ? '自動マージの条件をすべて満たしました。' : `自動マージしませんでした（${decision.stop ? '人が見る理由があります' : `${config.max_rounds} 周の上限まで試しました`}）。`,
    prUrl ? `\nPR: ${prUrl}` : '',
    '',
    '| 周 | 検証したコミット | ビルドと全テスト | 満足度 | XCUITest で合格 | 最終関門 | 不合格の必須シナリオ |',
    '| - | - | - | - | - | - | - |',
    ...state.rounds.map(roundRow),
    '',
    decision.reasons.length ? `## 満たせなかった条件\n\n${list(decision.reasons)}\n` : '',
    state.control ? `## 陰性対照（実装の前の、今のアプリ）\n\n満足度 ${pct(state.control.score)}。今のアプリでも合格したシナリオ: ${state.control.passed.join(', ') || 'なし'}（「やらないこと」や既存機能のシナリオなら問題ありません）\n` : '',
    last?.mutant ? `## 破壊役（わざと壊したアプリ）\n\n${last.mutant.detected === null ? last.mutant.note : last.mutant.detected ? '必須シナリオが壊れたことを見つけた。' : '**必須シナリオが壊れたことを見つけられなかった。**'}${last.mutant.what ? `\n\n壊した内容: ${String(last.mutant.what).trim().slice(0, 400)}` : ''}\n` : '',
    last?.diffLines !== undefined ? `## 変更の大きさ\n\n${last.diffLines} 行（上限 ${config.quality.max_changed_lines} 行）。テストのファイル: ${last.testsAdded === false ? 'なし' : last.testsAdded ? 'あり' : '—'}\n` : '',
    state.symptoms.length ? `## 最後の周で見つかった症状\n\n${list(state.symptoms)}\n` : '',
    state.candidates?.length ? `## 部品の候補\n\nデザインシステムにない部品を、既存の部品とトークンで組みました。部品にするかは \`/design-system:update\` で決めてください。\n\n${list(state.candidates)}\n` : '',
    state.review ? `## コードのレビュー（参考。マージは止めない）\n\n${state.review}\n` : '',
    metrics ? `## 工場の記録\n\n${metricsTable(metrics)}\n` : '',
  ].join('\n')
}

export async function runFeature({ entry, home, deps }) {
  const { repo, id } = entry
  const config = loadConfig(repo)
  const fdir = featureDir(projectHome(repo, home), id)
  const scenarioDir = join(fdir, 'scenarios')
  let state = { ...loadState(fdir, entry), status: 'running', paused_until: null }
  // 目印は、シナリオに埋めてあればそれを使い続ける（再開したときに別の目印にならないように）
  state.canary ??= existingCanary(scenarioDir) ?? randomBytes(8).toString('hex')
  plantCanary(scenarioDir, state.canary)
  saveState(fdir, state)
  const scenarios = readScenarios(scenarioDir)
  const dev = scenarios.filter((s) => !s.holdout)
  const holdouts = scenarios.filter((s) => s.holdout)
  if (!dev.length) throw new Error('開発用のシナリオがありません（すべて holdout になっています）')
  const work = join(deps.workRoot, projectSlug(repo))
  const wt = join(work, id)
  const derived = join(work, `${id}-derived`)
  const vwt = join(work, `${id}-verify`)
  const vderived = join(work, `${id}-verify-derived`)
  const mwt = join(work, `${id}-mutant`)
  const branch = `factory/${id}`
  const specRel = join('docs', 'factory', id, 'spec.md')
  const threshold = config.satisfaction.threshold
  const ui = config.ios.ui_tests

  // 工程が変わるたびに保存し、ログに 1 行と、その工程にかかった時間を残す。
  let at = { round: state.round, step: state.step, since: deps.now() }
  const save = () => {
    saveState(fdir, state)
    if (state.round === at.round && state.step === at.step) return
    record(fdir, { type: 'step', round: at.round, step: at.step, ms: deps.now() - at.since })
    deps.log(`${id}: ${state.round} 周目 ${state.step}`)
    at = { round: state.round, step: state.step, since: deps.now() }
  }
  const roundEntry = () => state.rounds.find((x) => x.round === state.round)
  const setRound = (entry) => [...state.rounds.filter((r) => r.round !== entry.round), entry].sort((a, b) => a.round - b.round)

  // 役を呼ぶ。設定のモデル名が codex で始まる役は Codex に、それ以外は Claude に回す。時間・費用・拒否を記録する。
  const call = async (name, role) => {
    const started = deps.now()
    const res = await withUsageWait(() => (isCodex(role.model) ? deps.codex(role) : deps.claude(role)), {
      now: deps.now,
      sleep: deps.sleep,
      onPause: (until) => {
        saveState(fdir, { ...state, status: 'paused', paused_until: until })
        deps.log(`利用上限のため ${new Date(until).toISOString()} まで一時停止します`)
      },
    })
    const usage = callUsage(res)
    record(fdir, { type: 'call', round: state.round, role: name, model: role.model, ms: deps.now() - started, ...usage, denials: usage.denials.length })
    return { res, usage }
  }

  // 実装役・破壊役が動いているあいだは、シナリオと実行の記録を読めなくしておく（サンドボックスの外で動く xcodebuild 対策の一つ）。
  const lockable = [scenarioDir, join(fdir, 'runs'), join(fdir, 'judgements')]
  const hidden = async (fn) => {
    for (const d of lockable) if (existsSync(d)) chmodSync(d, 0o000)
    try {
      return await fn()
    } finally {
      for (const d of lockable) if (existsSync(d)) chmodSync(d, 0o755)
    }
  }

  // 環境の事前確認。足りなければ 1 回だけ待ってやり直し、それでもだめなら工場のエラーとして止める（実装役の枠を使わない）。
  for (let attempt = 1; ; attempt++) {
    const problems = deps.adapter.preflight({ config, repo })
    if (!problems.length) break
    if (attempt === 2) throw new Error(`環境の事前確認に失敗しました: ${problems.join(' / ')}`)
    deps.log(`${id}: 環境の事前確認で問題があったので、少し待ってやり直します（${problems.join(' / ')}）`)
    await deps.sleep(10_000)
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
  const protectedPaths = [...new Set([...ALWAYS_PROTECTED, ...(ui ? [`${ui.dir}/**`] : []), ...config.protected_paths, ...(ds?.protected_paths ?? [])])]
  const udid = deps.adapter.udid(config)
  const cmds = deps.adapter.commands({ config, repo: wt, udid, derived })
  const vcmds = deps.adapter.commands({ config, repo: vwt, udid, derived: vderived })
  const bundleId = config.ios.bundle_id
  let decision = { merge: false, reasons: [], stop: false }

  const checkout = (dir, sha) => {
    if (existsSync(dir)) sh('git', ['worktree', 'remove', '--force', dir], repo)
    git(repo, 'worktree', 'add', '-q', '--detach', dir, sha)
  }

  // 検証役に 1 回操作させる。道具の都合（端末が使用中、権限など）で操作できなかった実行は、アプリの不具合ではない。
  // 1 回だけやり直し、それでもだめなら工場のエラーとして止め、実装役には何も渡さない。
  const verifyOnce = async ({ sc, app, out, session }) => {
    mkdirSync(out, { recursive: true })
    for (let attempt = 1; ; attempt++) {
      deps.adapter.closeSession(session)
      deps.adapter.resetApp({ udid, bundleId, app })
      // 前提のデータがあれば、入れ直したアプリに仕込んでから検証役に渡す
      if (sc.seed) deps.adapter.seedApp({ udid, bundleId, seed: sc.seed })
      await call('verify', ios.verifyRole({ config, udid, scenario: sc.path, scenarioDir, out, session }))
      deps.adapter.closeSession(session)
      const result = readVerifyResult(out)
      if (!result.blocked_by_tool) return
      if (attempt === 2) throw new Error(`検証の道具が動きませんでした（${sc.id}）: ${result.reason}`)
      deps.log(`${id}: ${sc.id} は道具の都合で操作できなかったので、やり直します（${result.reason}）`)
    }
  }

  const judge = async (sc, dirs) => {
    const prompt = render('judge', { scenario: sc.path, runs: list(dirs) })
    const model = config.models.judge
    // Codex は読むだけのサンドボックスで動かし、答えの形をスキーマで強制する。
    const role = isCodex(model) ? { cwd: fdir, model, sandbox: 'read-only', schema: JUDGE_SCHEMA, prompt } : { cwd: fdir, model, allowedTools: ['Read', 'Glob'], prompt }
    const { res } = await call('judge', role)
    // 症状は実装役に渡るので、万一シナリオの目印が混ざっていたら消しておく（漏れの誤検知を防ぐ）
    return parseJudgement(res.result, dirs.length).map((j) => ({ ...j, symptom: j.symptom?.replaceAll(state.canary, '') ?? null }))
  }

  // コミットした SHA を別のきれいなチェックアウトに取り出し、そこで 1 回だけビルドしたアプリで、シナリオを流す。
  // XCUITest のあるシナリオは先にそれを流し、通れば合格。通らないか、XCUITest がなければ検証役と判定役で確かめる。
  // rerun が on_failure なら、検証役の 1 回目が合格したシナリオはそこで終え、落ちたときだけ上限まで流し直す。
  const verifyAt = async ({ sha, list: targets, label, maxRuns = config.satisfaction.runs_per_scenario }) => {
    checkout(vwt, sha)
    const classes = {}
    for (const sc of ui ? targets.filter((t) => t.uiTest) : []) {
      const swift = readFileSync(sc.uiTest, 'utf8')
      const cls = ios.uiTestClass(swift)
      if (!cls) continue
      mkdirSync(join(vwt, ui.dir), { recursive: true })
      writeFileSync(join(vwt, ui.dir, `${cls}.swift`), swift)
      classes[sc.id] = cls
    }
    let built = deps.adapter.buildForVerify(vcmds, vwt)
    let uiTestBuild = Object.keys(classes).length ? (built.ok ? 'ok' : 'failed') : 'none'
    if (!built.ok && uiTestBuild === 'failed') {
      // シナリオの XCUITest がコンパイルできなかった。抜いて作り直し、検証役だけで確かめる（実装役には何も渡さない）
      deps.log(`${id}: シナリオの XCUITest がビルドできなかったので、検証役だけで確かめます`)
      for (const [sid, cls] of Object.entries(classes)) {
        rmSync(join(vwt, ui.dir, `${cls}.swift`))
        delete classes[sid]
      }
      built = deps.adapter.buildForVerify(vcmds, vwt)
    }
    if (!built.ok) throw new Error(`検証用のビルドに失敗しました（${sha.slice(0, 7)}）: ${built.command}\n${built.log}`)
    const app = deps.adapter.findApp(vderived)
    const runs = []
    for (const sc of targets) {
      const tag = { scenario: sc.id, required: sc.required }
      if (classes[sc.id]) {
        deps.adapter.resetApp({ udid, bundleId, app })
        const t = deps.adapter.runUiTest({ cmds: vcmds, cls: classes[sc.id], seed: sc.seed, cwd: vwt })
        mkdirSync(join(fdir, 'runs', label, sc.id), { recursive: true })
        writeFileSync(join(fdir, 'runs', label, sc.id, 'xcuitest.log'), t.log ?? '')
        if (t.ok) {
          runs.push({ ...tag, run: 1, satisfied: true, symptom: null, by: 'xcuitest' })
          continue
        }
      }
      for (let run = 1; run <= maxRuns; run++) {
        const out = join(fdir, 'runs', label, sc.id, String(run))
        await verifyOnce({ sc, app, out, session: `factory-${id}-${label}-${sc.id}-${run}`.slice(0, 80) })
        const [j] = await judge(sc, [out])
        runs.push({ ...tag, ...j, run, by: 'llm' })
        if (config.satisfaction.rerun === 'on_failure' && run === 1 && j.satisfied) break
      }
    }
    deps.adapter.shutdown(udid)
    mkdirSync(join(fdir, 'judgements'), { recursive: true })
    writeFileSync(join(fdir, 'judgements', `${label}.json`), JSON.stringify({ sha, uiTestBuild, runs }, null, 2))
    return { runs, uiTestBuild, summary: summarize(runs) }
  }

  // 陰性対照は 1 周目の実装の前に 1 回だけ行う。
  if (state.step === 'implement' && state.round === 1 && !state.rounds.length && config.control.base && !state.control) {
    state = { ...state, step: 'control' }
    at = { ...at, step: 'control' }
  }

  deps.log(`${id}: ${state.round} 周目 ${state.step} から始めます`)
  while (state.status === 'running') {
    const round = state.round

    // 陰性対照: 仕様だけのコミット（＝今のアプリ）でシナリオを流す。機能がないのに合格するなら、シナリオが機能を区別できていない。
    if (state.step === 'control') {
      const sha = git(wt, 'rev-parse', 'HEAD')
      const { runs, summary } = await verifyAt({ sha, list: scenarios, label: 'control', maxRuns: 1 })
      state = { ...state, control: { sha, score: summary.score, passed: [...new Set(runs.filter((r) => r.satisfied).map((r) => r.scenario))] } }
      if (summary.score >= threshold) {
        decision = { merge: false, stop: true, reasons: [`実装の前の今のアプリでも、シナリオの満足度が ${pct(summary.score)} で基準を超えた（シナリオが機能を区別できていない。シナリオを見直す）`] }
        state = { ...state, status: 'stopped', step: 'done' }
        save()
        writeFileSync(join(fdir, 'report.md'), report({ id, state, config, decision, metrics: summarizeMetrics(readMetrics(fdir)) }))
        if (config.notify.mac) deps.notify(`factory: ${id} で止まりました`, 'シナリオが今のアプリでも合格します。シナリオを見直してください')
        break
      }
      state = { ...state, step: 'implement' }
      save()
    }

    if (state.step === 'implement') {
      const before = git(wt, 'rev-parse', 'HEAD')
      const prompt = render('implement', {
        spec: specRel,
        round,
        symptoms: list(state.symptoms),
        tools: list(state.toolNotes ?? []),
        build: [cmds.prebuild, cmds.build].filter(Boolean).join(' && '),
        test: [cmds.prebuild, cmds.test].filter(Boolean).join(' && '),
        protected: list(protectedPaths),
        design: ds ? designRules(ds) : 'なし（このアプリにはデザインシステムがない。今ある画面の書き方に合わせる）',
      })
      const { res, usage } = await hidden(() => call('implement', { cwd: wt, model: config.models.implement, allowedTools: IMPLEMENT_TOOLS, hide: home, unsandboxed: UNSANDBOXED, prompt }))
      const candidates = [...new Set([...(state.candidates ?? []), ...parseComponentCandidates(String(res.result ?? ''))])]
      const toolNotes = [...new Set(usage.denials.map(describeDenial))]
      // 実装役がコミットし忘れても、検証するものとマージするものがずれないよう、ラインがコミットする
      if (git(wt, 'status', '--porcelain')) {
        git(wt, 'add', '-A')
        git(wt, 'commit', '-q', '-m', `Implement ${id} (factory round ${round})`)
      }
      const roundDiff = git(wt, 'diff', before, 'HEAD')
      if (String(res.result ?? '').includes(state.canary) || roundDiff.includes(state.canary)) {
        throw new Error('隠しシナリオが実装役に漏れました（シナリオに埋めた目印が、実装役の出力か差分に出ました）。この機能は止めます')
      }
      const buildScripts = buildScriptChanges(roundDiff)
      if (buildScripts.length) {
        // ビルドの設定に足したスクリプトは、サンドボックスの外の xcodebuild でシナリオを読めてしまう。その周の変更は捨てる
        git(wt, 'reset', '-q', '--hard', before)
        state = { ...state, step: 'decide', candidates, toolNotes, rounds: setRound({ round, discarded: true, buildScripts, tests: null, design: null, score: null, requiredFailures: [] }) }
      } else if (codeChanges().length === 0) {
        // 仕様のほかに何も変わっていなければ、テストも検証もせずに次へ
        state = { ...state, step: 'decide', candidates, toolNotes, rounds: setRound({ round, tests: null, design: null, score: null, requiredFailures: [], noChanges: true }) }
      } else {
        state = { ...state, step: 'test', candidates, toolNotes }
      }
      save()
    }

    if (state.step === 'test') {
      const sha = git(wt, 'rev-parse', 'HEAD')
      const t = deps.adapter.buildAndTest(cmds, wt)
      // デザインシステムのチェックと lint は、ビルドと全テストが通ったあとに行う。どれかが落ちたら、その周は検証しない。
      const d = t.ok && ds?.check ? shell(ds.check, wt) : null
      const l = t.ok && config.quality.lint ? shell(config.quality.lint, wt) : null
      const testsAdded = config.quality.require_tests ? codeChanges().some(isTestFile) : null
      const diffLines = changedLines(git(wt, 'diff', '--numstat', base, 'HEAD', '--', '.', `:(exclude)${specDir}`))
      const entry = {
        round, sha, tests: t.ok, design: d ? d.ok : null, lint: l ? l.ok : null, testsAdded, diffLines, score: null, requiredFailures: [],
        testLog: t.ok ? null : `${t.command}\n${t.log}`,
        designLog: d && !d.ok ? d.out.slice(-8000) : null,
        lintLog: l && !l.ok ? l.out.slice(-8000) : null,
      }
      const passed = t.ok && d?.ok !== false && l?.ok !== false && testsAdded !== false
      state = { ...state, step: passed ? 'verify' : 'decide', rounds: setRound(entry) }
      save()
    }

    if (state.step === 'verify') {
      const r = roundEntry()
      const { runs, uiTestBuild, summary } = await verifyAt({ sha: r.sha, list: dev, label: String(round) })
      const passed = summary.score >= threshold && !summary.requiredFailures.length
      const next = passed && holdouts.length ? 'holdout' : passed && config.control.mutant ? 'mutant' : 'decide'
      state = { ...state, step: next, rounds: setRound({ ...r, score: summary.score, requiredFailures: summary.requiredFailures, symptoms: summary.symptoms, uiTestBuild, xcuitest: runs.filter((x) => x.by === 'xcuitest').length }) }
      save()
    }

    // 最終関門: 開発用のシナリオが合格した周だけ流す。症状は実装役に返さない（返すと、周を重ねるうちに中身が伝わる）。
    if (state.step === 'holdout') {
      const r = roundEntry()
      const { summary } = await verifyAt({ sha: r.sha, list: holdouts, label: `${round}-holdout` })
      const passed = summary.score >= threshold && !summary.requiredFailures.length
      state = { ...state, step: passed && config.control.mutant ? 'mutant' : 'decide', rounds: setRound({ ...r, holdout: { score: summary.score, requiredFailures: summary.requiredFailures } }) }
      save()
    }

    // 破壊役: 合格した実装をわざと 1 か所壊し、必須シナリオがそれを見つけられるかを確かめる。
    if (state.step === 'mutant') {
      const r = roundEntry()
      checkout(mwt, r.sha)
      const { res } = await hidden(() => call('sabotage', { cwd: mwt, model: config.models.sabotage, allowedTools: SABOTAGE_TOOLS, hide: home, prompt: render('sabotage', { spec: specRel }) }))
      let mutant
      if (!git(mwt, 'status', '--porcelain')) {
        mutant = { detected: null, note: '破壊役が何も変えなかったので、確かめられなかった。' }
      } else {
        git(mwt, 'add', '-A')
        git(mwt, 'commit', '-q', '-m', `factory: sabotage ${id}`)
        const sha = git(mwt, 'rev-parse', 'HEAD')
        const required = scenarios.filter((s) => s.required)
        const { runs } = await verifyAt({ sha, list: required.length ? required : dev, label: `${round}-mutant`, maxRuns: 1 })
        mutant = { detected: runs.some((x) => !x.satisfied), sha, what: String(res.result ?? '') }
      }
      sh('git', ['worktree', 'remove', '--force', mwt], repo)
      state = { ...state, step: 'decide', rounds: setRound({ ...r, mutant }) }
      save()
    }

    if (state.step === 'decide') {
      const r = roundEntry()
      // 検証したコミットとブランチの先頭がずれていたら、何かがおかしい。マージの判定をしない
      if (r.sha && !r.discarded && git(wt, 'rev-parse', 'HEAD') !== r.sha) throw new Error(`検証したコミット ${r.sha.slice(0, 7)} と、ブランチの先頭が違います`)
      const changed = git(wt, 'diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean)
      const protectedHits = protectedChanges(changed, protectedPaths)
      decision = decideMerge({
        summary: { score: r.score ?? 0, requiredFailures: r.requiredFailures },
        threshold,
        testsPassed: r.tests === true,
        codeChanged: codeChanges().length > 0,
        designPassed: r.design ?? undefined,
        lintPassed: r.lint ?? undefined,
        testsAdded: r.testsAdded ?? undefined,
        buildScripts: r.buildScripts ?? [],
        ci: 'none',
        protectedHits,
        holdout: r.holdout ?? null,
        mutantDetected: r.mutant?.detected ?? null,
        diffLines: r.diffLines ?? 0,
        maxLines: config.quality.max_changed_lines,
      })
      const symptoms = [
        ...(r.noChanges ? ['実装の変更がない（仕様のほかに、変わったファイルがない）。仕様どおりにアプリのコードを変えること'] : []),
        ...(r.discarded ? ['ビルドの設定（project.yml のスクリプト、Run Script のビルドフェーズ、スキームの事前・事後の処理、Package.swift のプラグイン）にスクリプトを足したので、この周の変更はすべて捨てた。ビルドの設定にスクリプトを足さずに実装すること'] : []),
        ...(r.tests === false ? [`ビルドか全テストが通らない:\n${r.testLog}`] : []),
        ...(r.design === false ? [`デザインシステムの決まりに違反している（\`${ds.check}\` の結果）:\n${r.designLog}`] : []),
        ...(r.lint === false ? [`lint が通らない（\`${config.quality.lint}\` の結果）:\n${r.lintLog}`] : []),
        ...(r.testsAdded === false ? ['振る舞いを確かめるテストが足されていない。仕様の振る舞いごとに、テストを先に書いて実装すること'] : []),
        ...(protectedHits.length ? [`変更してはいけないファイルを変更した: ${protectedHits.join(', ')}`] : []),
        ...(r.symptoms ?? []),
      ]
      if (decision.merge) state = { ...state, step: 'merge', symptoms }
      else if (!decision.stop && round < config.max_rounds) state = { ...state, round: round + 1, step: 'implement', symptoms }
      else state = { ...state, step: 'stop', symptoms }
      save()
    }

    if (state.step === 'merge' || state.step === 'stop') {
      const merging = state.step === 'merge'
      const r = roundEntry()
      // 人がコードを読まないので、別のモデルのレビューを PR のレポートに載せる（マージは止めない）
      if (config.quality.review && state.review === undefined && codeChanges().length) {
        const model = config.models.review
        const prompt = render('review', { base, sha: git(wt, 'rev-parse', 'HEAD'), spec: specRel })
        try {
          const { res } = await call('review', isCodex(model) ? { cwd: wt, model, sandbox: 'read-only', prompt } : { cwd: wt, model, allowedTools: REVIEW_TOOLS, hide: home, prompt })
          state = { ...state, review: String(res.result ?? '').trim() || '指摘なし' }
        } catch (e) {
          state = { ...state, review: `（レビューできなかった: ${String(e.message).slice(0, 200)}）` }
        }
        save()
      }
      git(wt, 'push', '-q', '-u', 'origin', branch)
      if (merging) {
        // push したブランチの先頭が、検証したコミットであることを確かめる
        const remote = git(wt, 'ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0]
        if (remote !== r.sha) throw new Error(`origin のブランチの先頭 ${remote.slice(0, 7)} が、検証したコミット ${r.sha.slice(0, 7)} と違います`)
      }
      const body = report({ id, state, config, decision, metrics: summarizeMetrics(readMetrics(fdir)) })
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
          decision = { ...decision, merge: false, stop: true, reasons: [...decision.reasons, `GitHub の CI が ${ci}`] }
          state = { ...state, step: 'stop', symptoms: [`GitHub の CI が ${ci}`] }
          save()
          continue
        }
        // --delete-branch は手元のチェックアウトを既定のブランチに切り替えようとし、worktree では失敗するので付けない。
        // --match-head-commit で、検証したコミットのときだけマージする（あとから push されたものは混ざらない）。
        const m = deps.gh(['pr', 'merge', prUrl, '--squash', '--match-head-commit', r.sha], wt)
        if (!m.ok) {
          // マージ自体は GitHub で済んでいて、そのあとで失敗することがある。やり直したときもここに来る。
          const v = deps.gh(['pr', 'view', prUrl, '--json', 'state', '--jq', '.state'], wt)
          if (v.out.trim() !== 'MERGED') throw new Error(`マージに失敗しました: ${m.out}`)
        }
        sh('git', ['push', '-q', 'origin', '--delete', branch], wt)
      }
      state = { ...state, status: merging ? 'merged' : 'stopped', step: 'done' }
      save()
      writeFileSync(join(fdir, 'report.md'), report({ id, state, config, decision, prUrl, metrics: summarizeMetrics(readMetrics(fdir)) }))
      if (config.notify.mac) deps.notify(merging ? `factory: ${id} をマージしました` : `factory: ${id} で止まりました`, merging ? prUrl : `Draft PR: ${prUrl}`)
    }
  }

  for (const dir of [vwt, mwt]) if (existsSync(dir)) sh('git', ['worktree', 'remove', '--force', dir], repo)
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
