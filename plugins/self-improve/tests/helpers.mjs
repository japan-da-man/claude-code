// テスト用の足場。データ領域もホームも一時ディレクトリに向け、実際の ~/.claude には書かない。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findRepo } from '../scripts/lib/core.mjs'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const NOTE = join(ROOT, 'bin', 'harness-note')
export const script = (name) => join(ROOT, 'scripts', name)

const BASE_TIME = Date.parse('2026-11-16T09:00:00.000Z')
// 基準の時刻から minutes 分後（日は days で足す）。
export const at = (minutes = 0, days = 0) => new Date(BASE_TIME + minutes * 60_000 + days * 86_400_000).toISOString()

export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
}

// init 済みのリポジトリ（.git と harness/config.json がある）と、空のデータ領域・ホームを作る。
export function makeEnv({ config = {}, files = {}, initialized = true, name = 'demo-app' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'self-improve-test-'))
  const repo = join(base, name)
  const data = join(base, 'data')
  const home = join(base, 'home')
  const claudeHome = join(home, '.claude')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(claudeHome, { recursive: true })
  if (initialized) writeFiles(repo, { 'harness/config.json': config })
  writeFiles(repo, files)
  // 親プロセスの CLAUDE_* や HARNESS_* は引き継がない（テストの外の状態に左右されないように）。
  // 日付の表示は現地時刻なので、テストでは UTC に固定する。
  const env = { PATH: process.env.PATH, HOME: home, TZ: 'UTC', HARNESS_DATA_DIR: data, HARNESS_CLAUDE_HOME: claudeHome }
  return { base, repo, data, home, claudeHome, env, name }
}

export function runHook(file, input, t, { env = {}, now = null } = {}) {
  const run = spawnSync(process.execPath, [script(file)], {
    input: JSON.stringify({ cwd: t.repo, ...input }),
    encoding: 'utf8',
    cwd: t.repo,
    env: { ...t.env, ...(now ? { HARNESS_NOW: now } : {}), ...env },
  })
  let json = null
  try {
    json = JSON.parse(run.stdout)
  } catch {
    // JSON でない出力（または出力なし）
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, json }
}

// hook がそのセッションを見ている状態を作る（SessionStart が残す記録と同じもの）。
export function knownSession(t, id) {
  writeFiles(join(t.data, 'state', findRepo(t.repo).id, 'sessions', id), { 'start.json': { at: at(0), source: 'startup' } })
}

export function note(t, args, { env = {}, now = null, input = undefined, cwd = t.repo, known = true } = {}) {
  // lock は、hook が記録したセッションでしか始まらない。テストでは、既定でその状態を作っておく。
  if (args[0] === 'lock' && known) {
    const id = args.includes('--session') ? args[args.indexOf('--session') + 1] : env.HARNESS_SESSION_ID
    if (id) knownSession(t, id)
  }
  const run = spawnSync(process.execPath, [NOTE, ...args], {
    input,
    encoding: 'utf8',
    cwd,
    env: { ...t.env, ...(now ? { HARNESS_NOW: now } : {}), ...env },
  })
  let json = null
  try {
    json = JSON.parse(run.stdout)
  } catch {
    // JSON でない出力
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, json }
}

export function repoId(t) {
  return findRepo(t.repo).id
}

export function dataFiles(t, kind) {
  const base = join(t.data, kind)
  if (!existsSync(base)) return []
  return readdirSync(base, { recursive: true }).map(String).filter((f) => /\.[a-z]+$/.test(f)).sort()
}

export function readData(t, ...parts) {
  return readFileSync(join(t.data, ...parts), 'utf8')
}

export function events(t) {
  const base = join(t.data, 'events')
  if (!existsSync(base)) return []
  return readdirSync(base, { recursive: true }).map(String).filter((f) => f.endsWith('.jsonl')).sort()
    .flatMap((f) => readFileSync(join(base, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
}

// 異なるセッションで同じ原因キーの候補を記録する（自動改善の対象を作る）。
export function seedCandidates(t, key, sessions, { category = 'dev/mistake', now = at(0), text = null } = {}) {
  sessions.forEach((session) => {
    const run = note(t, ['add', '--session', session, '--category', category, '--key', key, '--text', text ?? `${key} の気づき（${session}）`], { now })
    if (run.status !== 0 || !run.stdout.includes('記録しました')) throw new Error(`seed failed: ${run.stdout}${run.stderr}`)
  })
}

// 自動改善のセッションを始める：keys それぞれに 2 セッション分の候補を作り、lock する。
export function startAuto(t, keys, { session = 'auto-1', now = at(0), lockAt = at(60) } = {}) {
  for (const key of keys) seedCandidates(t, key, [`${key}-s1`, `${key}-s2`], { now })
  const lock = note(t, ['lock', '--session', session], { now: lockAt })
  if (!lock.stdout.includes('自動改善を開始しました')) throw new Error(`lock failed: ${lock.stdout}${lock.stderr}`)
  return lock
}

export function draft(t, key, { session = 'auto-1', now = at(61), extra = [] } = {}) {
  return note(t, [
    'pending', 'add', '--session', session, '--key', key, '--root-cause', 'knowledge',
    '--asked', 'ユーザー一覧の API を足す', '--expected', 'src/routes/ にルートを置く', '--actual', 'src/api/ に置いた', ...extra,
  ], { now })
}

// hook の入力を作って流す、短い書き方。
export function session(t, id = 'sess-1') {
  const base = { session_id: id, transcript_path: `/tmp/transcripts/${id}.jsonl` }
  return {
    id,
    start: (source = 'startup', opts) => runHook('session-start.mjs', { ...base, hook_event_name: 'SessionStart', source }, t, opts),
    prompt: (promptId, prompt, opts) => runHook('log-event.mjs', { ...base, hook_event_name: 'UserPromptSubmit', prompt_id: promptId, prompt }, t, opts),
    used: (promptId, tool, input, opts) => runHook('log-event.mjs', { ...base, hook_event_name: 'PostToolUse', prompt_id: promptId, tool_name: tool, tool_input: input, tool_response: {} }, t, opts),
    failed: (promptId, tool, input, error, opts, extra = {}) =>
      runHook('log-event.mjs', { ...base, hook_event_name: 'PostToolUseFailure', prompt_id: promptId, tool_name: tool, tool_input: input, error, ...extra }, t, opts),
    stop: (promptId, lastMessage, opts, extra = {}) =>
      runHook('on-stop.mjs', { ...base, hook_event_name: 'Stop', prompt_id: promptId, stop_hook_active: false, last_assistant_message: lastMessage, ...extra }, t, opts),
  }
}
