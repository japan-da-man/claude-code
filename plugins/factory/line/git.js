// 作業の起点にする、origin の既定のブランチを決める。
// 手元の HEAD は使わない（push していないコミットが PR に混ざるため。2026-10-19 の本番規模の試運転で起きた）。
import { spawnSync } from 'node:child_process'

const has = (cwd, ref) => spawnSync('git', ['rev-parse', '--verify', '-q', ref], { cwd }).status === 0

export function originBase(cwd) {
  // clone せずに remote を足したリポジトリには origin/HEAD がないので、origin に聞いて作る
  if (!has(cwd, 'origin/HEAD')) spawnSync('git', ['remote', 'set-head', 'origin', '--auto'], { cwd })
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) if (has(cwd, ref)) return ref
  throw new Error('origin の既定のブランチが分かりません（git remote set-head origin --auto を確かめてください）')
}
