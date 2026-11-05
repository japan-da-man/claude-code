import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export function makeRepo(files = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'layered-review-'))
  writeFiles(repo, files)
  return repo
}

export function writeFiles(repo, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
}

export function git(repo, ...args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

// main に 1 つコミットした git のリポジトリ
export function makeGitRepo(files = { 'README.md': '# app\n' }) {
  const repo = makeRepo(files)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@example.com')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  return repo
}

export function commitAll(repo, message = 'change') {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', message)
  return git(repo, 'rev-parse', 'HEAD')
}

export function bugCase(over = {}) {
  return {
    id: 'C-001',
    kind: 'bug',
    title: 'キャッシュの消し忘れ',
    introduced: { base: 'a'.repeat(40), head: 'b'.repeat(40) },
    verified_by: 'nao',
    bugs: [
      { id: 'B1', path: 'api/fav.ts', lines: [10, 12], severity: 'high', class: 'cache', description: '消していない', trigger: '別の端末で開く' },
      { id: 'B2', path: 'api/fav.ts', lines: [30, 30], severity: 'low', class: 'log', description: 'ログが重複', trigger: '解除する' },
    ],
    ...over,
  }
}

export function cleanCase(over = {}) {
  return { id: 'C-002', kind: 'clean', title: '文言の変更', introduced: { base: 'c'.repeat(40), head: 'd'.repeat(40) }, verified_by: 'nao', bugs: [], ...over }
}
