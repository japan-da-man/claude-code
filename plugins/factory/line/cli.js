// スキルから呼ぶ小さな CLI。
//   node cli.js new <repo> <英語の機能名>   機能 ID を決めてフォルダを作り、置き場所を JSON で出す
//   node cli.js submit <repo> <id>          待ち行列に入れ、ラインが止まっていれば裏で起動する
//   node cli.js scenarios <repo> <id> <model>  シナリオ作成役を Codex で動かし、作ったシナリオの一覧を出す
//   node cli.js status                      ライン・待ち行列・機能の状態を JSON で出す
import { spawn as spawnChild } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { factoryHome, featureDir, featureId, projectHome } from './paths.js'
import { runCodex } from './codex.js'
import { enqueue, listQueue, readLock } from './queue.js'

const LINE = fileURLToPath(new URL('./line.js', import.meta.url))
const SCENARIO_WRITER = fileURLToPath(new URL('../agents/scenario-writer.md', import.meta.url))

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
  if (!readdirSync(join(dir, 'scenarios')).some((n) => n.endsWith('.md'))) throw new Error('承認したシナリオがありません')
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

export function statusReport(home = factoryHome()) {
  const features = []
  for (const project of existsSync(home) ? readdirSync(home, { withFileTypes: true }) : []) {
    if (!project.isDirectory() || project.name === 'queue') continue
    for (const id of readdirSync(join(home, project.name))) {
      const file = join(home, project.name, id, 'state.json')
      if (!existsSync(file)) continue
      const s = JSON.parse(readFileSync(file, 'utf8'))
      features.push({ repo: s.repo, id: s.id, status: s.status, round: s.round, step: s.step, lastScore: s.rounds.at(-1)?.score ?? null, pr: s.pr ?? null })
    }
  }
  return { line: { running: lineRunning(home), pid: readLock(home)?.pid ?? null }, queue: listQueue(home), features }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, a, b, c] = process.argv.slice(2)
  try {
    if (cmd === 'scenarios') {
      console.log(await writeScenarios({ repo: a, id: b, model: c }))
      process.exit(0)
    }
    const out = cmd === 'new' ? newFeature({ repo: a, name: b }) : cmd === 'submit' ? submit({ repo: a, id: b }) : cmd === 'status' ? statusReport() : null
    if (!out) throw new Error('使い方: cli.js new <repo> <name> | submit <repo> <id> | scenarios <repo> <id> <model> | status')
    console.log(JSON.stringify(out, null, 2))
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
