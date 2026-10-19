// スキルから呼ぶ小さな CLI。
//   <repo> は "." にすると、実行したフォルダの git リポジトリを使う
//   node cli.js new <repo> <英語の機能名>   機能 ID を決めてフォルダを作り、置き場所を JSON で出す
//   node cli.js submit <repo> <id>          待ち行列に入れ、ラインが止まっていれば裏で起動する
//   node cli.js scenarios <repo> <id> <model>  シナリオ作成役を Codex で動かし、作ったシナリオの一覧を出す
//   node cli.js mock-prepare <repo> <id>     UI 案を作るための、捨てる worktree を作り、置き場所を JSON で出す
//   node cli.js mock-shoot <repo> <id> <page...>  案のページをビルドしてシミュレーターで撮る
//   node cli.js mock-clean <repo> <id>       UI 案の worktree を消す
//   node cli.js status                      ライン・待ち行列・機能の状態を JSON で出す
//   node cli.js feedback <repo> <id> good|bad [メモ]  マージされたアプリを人が触った評価を残す（判定との一致率を測る）
import { spawn as spawnChild, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { factoryHome, featureDir, featureId, projectHome, projectSlug } from './paths.js'
import { homedir } from 'node:os'
import { runCodex } from './codex.js'
import { cleanMock, prepareMock, shootCommand } from './mock.js'
import { readMetrics, summarizeMetrics } from './metrics.js'
import { enqueue, listQueue, readLock } from './queue.js'

const LINE = fileURLToPath(new URL('./line.js', import.meta.url))
const SCENARIO_WRITER = fileURLToPath(new URL('../agents/scenario-writer.md', import.meta.url))

// "." か省略なら、コマンドを実行したフォルダの git リポジトリの一番上を使う。
// スキルで "$(git rev-parse --show-toplevel)" と書くと、コマンド置換のせいで allowed-tools に合わず、毎回許可を求められるため。
export function resolveRepo(arg, cwd = process.cwd()) {
  if (arg && arg !== '.') return resolve(arg)
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cwd} は git のリポジトリの中ではありません`)
  return r.stdout.trim()
}

export function newFeature({ repo, name, home = factoryHome(), date = new Date() }) {
  const base = featureId(name, date)
  const pdir = projectHome(resolve(repo), home)
  let id = base
  for (let n = 2; existsSync(join(pdir, id)); n++) id = `${base}-${n}`
  const dir = featureDir(pdir, id)
  mkdirSync(join(dir, 'scenarios'), { recursive: true })
  return { id, dir, spec: join(dir, 'spec.md'), scenarios: join(dir, 'scenarios') }
}

function lineRunning(home) {
  const lock = readLock(home)
  if (!lock) return false
  try {
    process.kill(lock.pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// ラインは手元のセッションから切り離して動かし、ログは ~/.factory/line.log に残す。
function spawnLine(home) {
  mkdirSync(home, { recursive: true })
  const out = openSync(join(home, 'line.log'), 'a')
  // path.matchesGlob がまだ experimental で、毎回ログに警告が出るので止める。
  spawnChild(process.execPath, ['--disable-warning=ExperimentalWarning', LINE], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, FACTORY_HOME: home } }).unref()
}

export function startLine({ home = factoryHome(), spawn = spawnLine } = {}) {
  if (lineRunning(home)) return false
  spawn(home)
  return true
}

export function submit({ repo, id, home = factoryHome(), spawn = spawnLine }) {
  const abs = resolve(repo)
  const dir = featureDir(projectHome(abs, home), id)
  if (!existsSync(join(dir, 'spec.md'))) throw new Error(`${join(dir, 'spec.md')} がありません`)
  const scenarios = readdirSync(join(dir, 'scenarios')).filter((n) => n.endsWith('.md'))
  if (!scenarios.length) throw new Error('承認したシナリオがありません')
  if (scenarios.every((n) => /^holdout:\s*true\s*$/m.test(readFileSync(join(dir, 'scenarios', n), 'utf8')))) throw new Error('すべてのシナリオが最終関門（holdout）になっています。開発用のシナリオを残してください')
  enqueue(home, { repo: abs, id })
  return { queued: id, started: startLine({ home, spawn }) }
}

// シナリオ作成役を Codex にしたとき（models.scenario が codex）に使う。役の説明は agents/scenario-writer.md を共有する。
// 作業ディレクトリを機能のフォルダにし、workspace-write で書けるのはそこ（と一時フォルダ）だけにする。
export async function writeScenarios({ repo, id, home = factoryHome(), model, run = runCodex }) {
  const abs = resolve(repo)
  const dir = featureDir(projectHome(abs, home), id)
  const spec = join(dir, 'spec.md')
  if (!existsSync(spec)) throw new Error(`${spec} がありません`)
  const role = readFileSync(SCENARIO_WRITER, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')
  const prompt = `${role}\n\n## 今回の入力\n\n- 仕様: ${spec}\n- シナリオを書き出すフォルダ: ${join(dir, 'scenarios')}\n- 対象のリポジトリ（読むだけ。変更しない）: ${abs}\n`
  const out = await run({ cwd: dir, sandbox: 'workspace-write', model, prompt })
  return out.result
}

// 案の画像（見比べる用）と、選んだ案の画像（仕様と一緒にブランチに入る）は別のフォルダに置く。
export function mockPaths({ repo, id, home = factoryHome(), workRoot = join(homedir(), 'Library', 'Caches', 'factory') }) {
  const abs = resolve(repo)
  const dir = featureDir(projectHome(abs, home), id)
  const work = join(workRoot, projectSlug(abs))
  return { options: join(dir, 'ui-options'), chosen: join(dir, 'ui'), work, worktree: join(work, `${id}-mock`), derived: join(work, `${id}-mock-derived`) }
}

export function mockPrepare({ repo, id, home = factoryHome() }) {
  const p = mockPaths({ repo, id, home })
  return prepareMock({ repo: resolve(repo), id, workRoot: p.work, outDir: p.options })
}

export function mockShoot({ repo, id, pages, home = factoryHome(), exec = runShoot }) {
  // この Mac ではシミュレーターを 1 台しか動かせないので、ラインが使っている間は撮らない。
  if (lineRunning(home)) throw new Error('ラインがシミュレーターを使っているので撮れません。/factory:status でラインが止まるのを待ってください')
  const p = mockPaths({ repo, id, home })
  return exec(shootCommand({ dir: p.worktree, pages, out: p.options }))
}

function runShoot({ cmd, args, cwd }) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, FACTORY_HOME: factoryHome() } })
  if (r.status !== 0) throw new Error(`撮影に失敗しました: ${(r.stderr || r.stdout).slice(-4000)}`)
  return JSON.parse(r.stdout)
}

export function mockClean({ repo, id, home = factoryHome() }) {
  const p = mockPaths({ repo, id, home })
  cleanMock({ repo: resolve(repo), dir: p.worktree })
  return { removed: p.worktree }
}

// 人の評価。判定役が合格にしたもの（マージされたもの）を人が触って、good か bad かを残す。
export function feedback({ repo, id, verdict, note = '', home = factoryHome(), now = new Date() }) {
  if (!['good', 'bad'].includes(verdict)) throw new Error('評価は good か bad で書いてください')
  const dir = featureDir(projectHome(resolve(repo), home), id)
  if (!existsSync(join(dir, 'state.json'))) throw new Error(`${id} はまだラインに流れていません`)
  const entry = { verdict, note, at: now.toISOString() }
  writeFileSync(join(dir, 'feedback.json'), JSON.stringify(entry, null, 2))
  return { id, ...entry }
}

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

export function statusReport(home = factoryHome()) {
  const features = []
  for (const project of existsSync(home) ? readdirSync(home, { withFileTypes: true }) : []) {
    if (!project.isDirectory() || project.name === 'queue') continue
    for (const id of readdirSync(join(home, project.name))) {
      const dir = join(home, project.name, id)
      const s = readJson(join(dir, 'state.json'))
      if (!s) continue
      const m = summarizeMetrics(readMetrics(dir))
      features.push({
        repo: s.repo, id: s.id, status: s.status, round: s.round, step: s.step, lastScore: s.rounds.at(-1)?.score ?? null, pr: s.pr ?? null,
        minutes: Math.round(m.total_ms / 6000) / 10, cost_usd: Math.round(m.cost_usd * 100) / 100,
        feedback: readJson(join(dir, 'feedback.json'))?.verdict ?? null,
      })
    }
  }
  // 判定役が合格にした（マージした）もののうち、人も good と言った割合
  const rated = features.filter((f) => f.status === 'merged' && f.feedback)
  const agreement = { rated: rated.length, good: rated.filter((f) => f.feedback === 'good').length, rate: rated.length ? rated.filter((f) => f.feedback === 'good').length / rated.length : null }
  return { line: { running: lineRunning(home), pid: readLock(home)?.pid ?? null }, queue: listQueue(home), features, agreement }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, repoArg, b, c] = process.argv.slice(2)
  try {
    const a = cmd === 'status' ? undefined : resolveRepo(repoArg)
    if (cmd === 'scenarios') {
      console.log(await writeScenarios({ repo: a, id: b, model: c }))
      process.exit(0)
    }
    const pages = process.argv.slice(5)
    const out =
      cmd === 'new' ? newFeature({ repo: a, name: b })
      : cmd === 'submit' ? submit({ repo: a, id: b })
      : cmd === 'mock-prepare' ? mockPrepare({ repo: a, id: b })
      : cmd === 'mock-shoot' ? mockShoot({ repo: a, id: b, pages })
      : cmd === 'mock-clean' ? mockClean({ repo: a, id: b })
      : cmd === 'status' ? statusReport()
      : cmd === 'feedback' ? feedback({ repo: a, id: b, verdict: c, note: process.argv.slice(6).join(' ') })
      : null
    if (!out) throw new Error('使い方: cli.js new <repo> <name> | submit <repo> <id> | scenarios <repo> <id> <model> | mock-prepare|mock-clean <repo> <id> | mock-shoot <repo> <id> <page...> | status | feedback <repo> <id> good|bad [メモ]')
    console.log(JSON.stringify(out, null, 2))
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
