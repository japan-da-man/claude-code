// スキルから呼ぶ CLI。結果は JSON で出す。
//   node cli.mjs install <repo>   docs/features/ を作り、ないものだけひな形（actors.md）を置く
//   node cli.mjs index <repo>     機能ファイルから docs/features/README.md の一覧を作り直す（エラーがあれば作らない）
//   node cli.mjs check <repo>     機能マスタを調べる（check.mjs と同じ結果）
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ACTORS, FEATURES_DIR, INDEX, loadActors, loadFeatures, renderIndex, runCheck } from './check.mjs'

const TEMPLATES = fileURLToPath(new URL('../templates', import.meta.url))

export function install(repo) {
  mkdirSync(join(repo, FEATURES_DIR), { recursive: true })
  const actors = `${FEATURES_DIR}/${ACTORS}`
  const exists = existsSync(join(repo, actors))
  if (!exists) copyFileSync(join(TEMPLATES, ACTORS), join(repo, actors))
  return { dir: FEATURES_DIR, copied: exists ? [] : [actors], skipped: exists ? [actors] : [], template: join(TEMPLATES, 'feature.md') }
}

export function writeIndex(repo) {
  const r = runCheck(repo)
  if (!r.ok) return { written: null, errors: r.errors }
  const file = `${FEATURES_DIR}/${INDEX}`
  writeFileSync(join(repo, file), renderIndex(loadFeatures(repo), loadActors(repo)))
  return { written: file, features: r.features, errors: [] }
}

const USAGE = 'node cli.mjs install|index|check <repo>'

export function main(argv) {
  const [command, repoArg] = argv
  if (!repoArg) throw new Error(`使い方: ${USAGE}`)
  const repo = resolve(repoArg)
  switch (command) {
    case 'install':
      return install(repo)
    case 'index':
      return writeIndex(repo)
    case 'check':
      return runCheck(repo)
    default:
      throw new Error(`使い方: ${USAGE}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const r = main(process.argv.slice(2))
    console.log(JSON.stringify(r, null, 2))
    if (r?.errors?.length || r?.ok === false) process.exitCode = 1
  } catch (e) {
    console.error(e.message)
    process.exitCode = 1
  }
}
