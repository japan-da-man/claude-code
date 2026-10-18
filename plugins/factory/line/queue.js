// 待ち行列とラインのロック。どちらも ~/.factory 直下に置く。
// この Mac ではシミュレーターを 1 台しか動かせないので、ラインはプロジェクトをまたいで 1 本にする。
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const queueDir = (home) => join(home, 'queue')
const lockFile = (home) => join(home, 'line.lock')

// ファイル名の先頭を投入時刻にして、名前順がそのまま投入順になるようにする。
// 1 件 1 ファイルなので、インタビューのセッションとラインが同時に触っても壊れない。
export function enqueue(home, entry, now = Date.now()) {
  mkdirSync(queueDir(home), { recursive: true })
  if (listQueue(home).some((e) => e.repo === entry.repo && e.id === entry.id)) return
  const name = `${String(now).padStart(15, '0')}-${entry.id}.json`
  writeFileSync(join(queueDir(home), name), JSON.stringify({ repo: entry.repo, id: entry.id }))
}

function entries(home) {
  let names
  try {
    names = readdirSync(queueDir(home)).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }
  return names.map((name) => ({ name, ...JSON.parse(readFileSync(join(queueDir(home), name), 'utf8')) }))
}

export function listQueue(home) {
  return entries(home).map(({ repo, id }) => ({ repo, id }))
}

// 取り出すのはロックを持つラインだけなので、読んで消すだけでよい。
export function dequeue(home) {
  const [first] = entries(home)
  if (!first) return null
  rmSync(join(queueDir(home), first.name))
  return { repo: first.repo, id: first.id }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

export function acquireLock(home, pid = process.pid) {
  mkdirSync(home, { recursive: true })
  try {
    writeFileSync(lockFile(home), JSON.stringify({ pid }), { flag: 'wx' })
    return true
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
  const holder = readLock(home)
  if (holder && alive(holder.pid)) return false
  // 落ちたラインが残したロックは引き継ぐ。
  rmSync(lockFile(home), { force: true })
  return acquireLock(home, pid)
}

export function readLock(home) {
  try {
    return JSON.parse(readFileSync(lockFile(home), 'utf8'))
  } catch {
    return null
  }
}

export function releaseLock(home, pid = process.pid) {
  if (readLock(home)?.pid === pid) rmSync(lockFile(home), { force: true })
}
