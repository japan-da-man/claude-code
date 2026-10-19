// UI 案の段階: 案ごとの画面をデザインシステムの部品で作り、シミュレーターで撮って人に選んでもらう。
// 案のコードは捨てるための worktree（origin の最新から detached で作る）にだけ書き、撮り終えたら worktree ごと消す。
// 案の画面はカタログのページ（起動引数 -DesignSystemCatalog <ページ>）として出す。カタログの切り替えも、その worktree の中でだけ書き換える。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESIGN_SYSTEM_FILE } from './design.js'

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} が失敗しました: ${r.stdout}${r.stderr}`)
  return r.stdout.trim()
}

export function prepareMock({ repo, id, workRoot, outDir }) {
  const file = join(repo, DESIGN_SYSTEM_FILE)
  if (!existsSync(file)) throw new Error(`${file} がありません。UI 案は design-system の部品で作るので、先に /design-system:init を実行してください`)
  const ios = JSON.parse(readFileSync(file, 'utf8')).ios ?? {}
  if (!ios.code || !ios.sources?.length) throw new Error(`${file} に ios.code と ios.sources がありません`)
  const dir = join(workRoot, `${id}-mock`)
  if (existsSync(dir)) cleanMock({ repo, dir })
  mkdirSync(workRoot, { recursive: true })
  spawnSync('git', ['fetch', '-q', 'origin'], { cwd: repo })
  const base = spawnSync('git', ['rev-parse', '--verify', '-q', 'origin/HEAD'], { cwd: repo }).status === 0 ? 'origin/HEAD' : 'HEAD'
  git(repo, 'worktree', 'add', '-q', '--detach', dir, base)
  mkdirSync(outDir, { recursive: true })
  return {
    dir,
    mocks: join(dir, ios.sources[0], 'FactoryMocks'),
    catalog: join(dir, ios.code, 'Catalog', 'DesignSystemCatalog.swift'),
    out: outDir,
  }
}

export function cleanMock({ repo, dir }) {
  spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: repo })
}

// 撮影はアプリの design-system/shoot.mjs（design-system プラグインが写す）に任せる。案は見比べるだけなのでライトだけ。
// 撮った画像は <out>/<ページ>-light.png になる。
export function shootCommand({ dir, pages, out }) {
  if (!existsSync(join(dir, 'design-system', 'shoot.mjs'))) {
    throw new Error('このアプリの design-system/shoot.mjs がありません。/design-system:update でデザインシステムを新しい版にしてください')
  }
  return { cmd: process.execPath, args: ['design-system/shoot.mjs', '--pages', [...new Set(pages)].join(','), '--appearance', 'light', '--out', out], cwd: dir }
}
