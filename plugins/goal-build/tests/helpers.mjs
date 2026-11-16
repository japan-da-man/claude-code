// テスト用の足場。一時ディレクトリに git リポジトリを作り、フックのスクリプトを stdin つきで動かす。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const script = (name) => join(ROOT, 'scripts', name)
export const FEATURE_DIR = 'docs/specs/rate-limit'

export function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}
const git = (cwd, ...args) => sh(cwd, 'git', args)

export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

// check.sh の結果はリポジトリの外のファイル（mode）で切り替える。実行されるたびに ran.log に 1 行足す。
const CHECK = `#!/usr/bin/env bash
base="$(dirname "$(git rev-parse --show-toplevel)")"
echo run >> "$base/ran.log"
mode=$(cat "$base/mode" 2>/dev/null || echo pass)
case "$mode" in
  pass) echo "all checks passed"; exit 0 ;;
  *) echo "FAIL: \${mode#fail:}"; echo "Duration $RANDOM ms"; exit 1 ;;
esac
`

// フロー実行中（承認コミット済み）のリポジトリを作る。active: false ならフローなし。
export function makeRepo({ active = true, state = 'implementing', check = true, files = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'goal-build-test-'))
  const repo = join(base, 'app')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  writeFiles(repo, {
    '.gitignore': '.goal-build/*\n!.goal-build/check.sh\n!.goal-build/config\n',
    'src/app.ts': 'export const app = 1\n',
    [`${FEATURE_DIR}/SPEC.md`]: '---\nstatus: approved\n---\n# spec\n- AC-1: works\n',
    [`${FEATURE_DIR}/PROGRESS.md`]: '## タスク\n- [x] AC-1 の土台\n- [ ] AC-1 の 429 応答\n- [ ] AC-2 / ヘッダー\n',
    'docs/specs/other/SPEC.md': '# other\n',
    ...files,
  })
  if (check) {
    writeFiles(repo, { '.goal-build/check.sh': CHECK, '.goal-build/config': 'BASE_BRANCH=main\nREVIEW_AGENT=\n' })
    chmodSync(join(repo, '.goal-build/check.sh'), 0o755)
  }
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'approved spec')
  const approved = git(repo, 'rev-parse', 'HEAD')
  if (active) {
    writeFiles(repo, { '.goal-build/active': `${FEATURE_DIR}\n${approved}\n${approved}\n` })
    if (state) writeFiles(repo, { '.goal-build/state': `${state}\n` })
  }
  return {
    base,
    repo,
    approved,
    setCheck: (mode) => writeFileSync(join(base, 'mode'), mode),
    runs: () => (existsSync(join(base, 'ran.log')) ? readFileSync(join(base, 'ran.log'), 'utf8').trim().split('\n').length : 0),
    read: (rel) => (existsSync(join(repo, rel)) ? readFileSync(join(repo, rel), 'utf8').trim() : null),
    write: (files) => writeFiles(repo, files),
  }
}

// フックのスクリプトを動かす。input は stdin に渡す JSON。
export function runHook(name, repo, input = {}, extraEnv = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PROJECT_DIR: repo, ...extraEnv }
  const r = spawnSync('bash', [script(name)], { cwd: repo, input: JSON.stringify(input), encoding: 'utf8', env })
  let json = null
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null } catch { /* テキスト出力 */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json }
}
