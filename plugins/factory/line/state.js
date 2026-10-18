// 機能ごとの進み具合（state.json）。工程が終わるたびに保存し、止まっても続きから再開する。
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function loadState(dir, { id, repo }) {
  try {
    return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  return { id, repo, status: 'running', round: 1, step: 'implement', symptoms: [], rounds: [], paused_until: null }
}

// 書いている途中で落ちても壊れたファイルが残らないよう、別名で書いてから置き換える。
export function saveState(dir, state) {
  const tmp = join(dir, `.state.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, join(dir, 'state.json'))
}
