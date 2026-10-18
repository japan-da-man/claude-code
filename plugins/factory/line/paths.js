// 工場のファイルの置き場所と、機能 ID の作り方。
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

// シナリオなどリポジトリの外に置くものの根っこ。テストでは差し替える。
export function factoryHome() {
  return process.env.FACTORY_HOME || join(homedir(), '.factory')
}

// 同じ名前のリポジトリが別の場所にあっても混ざらないよう、絶対パスのハッシュを付ける。
export function projectSlug(repo) {
  const abs = resolve(repo)
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 8)
  return `${basename(abs)}-${hash}`
}

export function projectHome(repo, home = factoryHome()) {
  return join(home, projectSlug(repo))
}

const ID = /^\d{8}-[a-z0-9]+(-[a-z0-9]+)*$/

export function featureDir(projectDir, id) {
  if (!ID.test(id)) throw new Error(`機能 id の形式が不正です: ${id}`)
  return join(projectDir, id)
}

export function featureId(name, date = new Date()) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!slug) throw new Error('機能名は英語で付けてください（例: share-memo）')
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${slug}`
}
