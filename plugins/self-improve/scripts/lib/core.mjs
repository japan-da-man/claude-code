// hook のスクリプトと harness-note が共有する土台。
// リポジトリの特定、設定の読み込み、データ領域の解決、ファイルの読み書き、生ログ。
// 外部の依存は使わない（Node.js 標準だけ）。ネットワークには出ない。
import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN = 'self-improve'
export const PLUGIN_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const NOTE_BIN = join(PLUGIN_ROOT, 'bin', 'harness-note')
export const LOCK_TTL_MS = 2 * 60 * 60 * 1000
export const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULT_CONFIG = {
  trial_review_days: 60,
  episode_retention_days: 90,
  budget: { claude_md_lines: 100, always_loaded_rule_lines: 50, scoped_rule_file_lines: 50 },
  candidates: {
    min_sessions: 2,
    preference_min_sessions: 3,
    max_per_session: 3,
    categories: ['dev/bug', 'dev/cause', 'dev/mistake', 'dev/other', 'behavior/preference'],
  },
  auto: { interval_days: 0, max_per_run: 3, max_unreviewed: 5, max_trial_rules: 10, max_trial_skills: 5 },
  prune: { interval_days: 30 },
  verify: [],
}

// 自動改善の対象にするカテゴリ（設計書 4 章）。ほかは報告に載せるだけ。
export const AUTO_CATEGORIES = ['dev/cause', 'dev/mistake']
export const BUG_CATEGORY = 'dev/bug'
export const OTHER_CATEGORY = 'dev/other'
export const PREFERENCE_CATEGORY = 'behavior/preference'

// ---- 時刻 ----

// テストのとき（HARNESS_TEST=1）だけ、HARNESS_NOW（ISO 8601）で現在時刻を固定できる。
// ふだんは読まない。時刻を偽って、間隔の判定やロックの失効を動かせないようにするため。
export function now() {
  const fixed = process.env.HARNESS_TEST === '1' ? process.env.HARNESS_NOW : null
  if (fixed) {
    const d = new Date(fixed)
    if (!Number.isNaN(d.getTime())) return d
  }
  return new Date()
}
export const iso = (d = now()) => d.toISOString()
// 人に見せる日付と、日付ごとのファイル名は、そのマシンの現地時刻で決める。
const pad = (n) => String(n).padStart(2, '0')
export const dayOf = (d = now()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export function daysBetween(from, to = now()) {
  const t = new Date(from).getTime()
  if (Number.isNaN(t)) return 0
  return Math.floor((to.getTime() - t) / DAY_MS)
}
export function stamp(d = now()) {
  return iso(d).replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

// ---- 入出力 ----

export function disabled() {
  return process.env.HARNESS_DISABLE === '1'
}

// そのスクリプトが直接実行されたか（import されただけではないか）。
export function isMain(url) {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url))
  } catch {
    return false
  }
}

export function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

export function readHookInput() {
  try {
    const parsed = JSON.parse(readStdin() || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// 書きかけのファイルを読ませないよう、別名で書いてから置き換える。
export function writeFileAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, file)
}
export const writeJson = (file, value) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)

export function listFiles(dir, filter = () => true) {
  try {
    return readdirSync(dir).filter(filter).sort()
  } catch {
    return []
  }
}

export function sha(text, length = 12) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, length)
}

export function randomId(prefix) {
  return `${prefix}-${stamp()}-${randomBytes(2).toString('hex')}`
}

// ファイル名に使う ID を、安全な文字だけにする。
export function safeId(value, fallback = 'unknown') {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128)
  return cleaned || fallback
}

export function slug(value, fallback = 'repo') {
  const cleaned = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return cleaned || fallback
}

export const posix = (p) => p.split(sep).join('/')

export function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// 存在しないパスでも、存在する祖先までを実体のパスに直す（シンボリックリンク経由の抜け道を塞ぐ）。
export function realish(target) {
  let current = resolve(target)
  const tail = []
  for (;;) {
    try {
      return join(realpathSync(current), ...tail.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(target)
      tail.push(basename(current))
      current = parent
    }
  }
}

// ---- リポジトリ ----

function commonDirOf(dotgit, stat) {
  let gitdir = dotgit
  if (stat.isFile()) {
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotgit, 'utf8'))
    if (!match) return null
    gitdir = resolve(dirname(dotgit), match[1])
  }
  try {
    const common = readFileSync(join(gitdir, 'commondir'), 'utf8').trim()
    if (common) gitdir = resolve(gitdir, common)
  } catch {
    // commondir がなければ、その gitdir が共通ディレクトリ
  }
  try {
    return realpathSync(gitdir)
  } catch {
    return null
  }
}

// cwd から上へたどって .git を探す。リポジトリ ID は git の共通ディレクトリのパスから作るので、
// worktree でも同じ ID になる。git コマンドは呼ばない。
export function findRepo(start) {
  let dir
  try {
    dir = realpathSync(resolve(start || process.cwd()))
  } catch {
    return null
  }
  for (;;) {
    const dotgit = join(dir, '.git')
    let stat = null
    try {
      stat = statSync(dotgit)
    } catch {
      // 上の階層を探す
    }
    if (stat) {
      const common = commonDirOf(dotgit, stat)
      if (common) {
        const raw = basename(common) === '.git' ? basename(dirname(common)) : basename(common).replace(/\.git$/, '')
        const name = slug(raw)
        return { root: dir, commonDir: common, name, id: `${name}-${sha(common)}` }
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// ---- 設定 ----

const count = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback)

export function configPath(root) {
  return join(root, 'harness', 'config.json')
}

// harness/config.json がなければ null（＝ init していないリポジトリ。hook は何もしない）。
// 壊れていても初期値で動かし、error に理由を残す。
export function loadConfig(root) {
  const file = configPath(root)
  if (!existsSync(file)) return null
  let raw = {}
  let error = null
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('オブジェクトではありません')
  } catch (e) {
    error = e.message
    raw = {}
  }
  const d = DEFAULT_CONFIG
  const categories = Array.isArray(raw.candidates?.categories) && raw.candidates.categories.every((c) => typeof c === 'string' && c)
    ? raw.candidates.categories
    : d.candidates.categories
  const verify = Array.isArray(raw.verify)
    ? raw.verify.filter((v) => v && typeof v.run === 'string' && v.run.trim()).map((v, i) => ({
      name: typeof v.name === 'string' && v.name ? v.name : `verify-${i + 1}`,
      run: v.run,
      timeout_sec: count(v.timeout_sec, 240) || 240,
    }))
    : []
  return {
    file,
    error,
    trial_review_days: count(raw.trial_review_days, d.trial_review_days),
    episode_retention_days: count(raw.episode_retention_days, d.episode_retention_days),
    budget: {
      claude_md_lines: count(raw.budget?.claude_md_lines, d.budget.claude_md_lines),
      always_loaded_rule_lines: count(raw.budget?.always_loaded_rule_lines, d.budget.always_loaded_rule_lines),
      scoped_rule_file_lines: count(raw.budget?.scoped_rule_file_lines, d.budget.scoped_rule_file_lines),
    },
    candidates: {
      min_sessions: Math.max(1, count(raw.candidates?.min_sessions, d.candidates.min_sessions)),
      preference_min_sessions: Math.max(1, count(raw.candidates?.preference_min_sessions, d.candidates.preference_min_sessions)),
      max_per_session: count(raw.candidates?.max_per_session, d.candidates.max_per_session),
      categories,
    },
    auto: {
      interval_days: count(raw.auto?.interval_days, d.auto.interval_days),
      max_per_run: count(raw.auto?.max_per_run, d.auto.max_per_run),
      max_unreviewed: count(raw.auto?.max_unreviewed, d.auto.max_unreviewed),
      max_trial_rules: count(raw.auto?.max_trial_rules, d.auto.max_trial_rules),
      max_trial_skills: count(raw.auto?.max_trial_skills, d.auto.max_trial_skills),
    },
    prune: { interval_days: count(raw.prune?.interval_days, d.prune.interval_days) },
    correction_words: Array.isArray(raw.correction_words) ? raw.correction_words.filter((w) => typeof w === 'string' && w) : [],
    verify,
  }
}

// ---- データ領域 ----

// ~/.claude に当たる場所。テストでは HARNESS_CLAUDE_HOME で一時ディレクトリに向ける。
export function claudeHome() {
  return resolve(process.env.HARNESS_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
}
export function personalSkillsDir() {
  return join(claudeHome(), 'skills')
}
function pluginsRoot() {
  return resolve(process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR || join(claudeHome(), 'plugins'))
}

const HANDOFF = 'handoff.json'

// SessionStart の hook が残した引き渡しのファイルから、データ領域を探す。
function handoffDataDir() {
  const base = join(pluginsRoot(), 'data')
  let best = null
  for (const name of listFiles(base)) {
    const dir = join(base, name)
    const handoff = readJson(join(dir, HANDOFF))
    if (!handoff || handoff.plugin !== PLUGIN) continue
    const score = (handoff.plugin_root === PLUGIN_ROOT ? 1e15 : 0) + (Date.parse(handoff.updated_at) || 0)
    if (!best || score > best.score) best = { dir, score }
  }
  return best?.dir ?? null
}

// 既定のパスの計算。<plugins>/data/<プラグインID>。ID はインストール元から決まる。
//   cache/<marketplace>/<plugin>/<version>/ から読み込まれていれば <plugin>-<marketplace>
//   それ以外（--plugin-dir など）は <plugin>-inline
function defaultDataDir() {
  const cache = join(pluginsRoot(), 'cache')
  let id = `${PLUGIN}-inline`
  if (isInside(cache, PLUGIN_ROOT)) {
    const [marketplace, plugin] = relative(cache, PLUGIN_ROOT).split(sep)
    if (marketplace && plugin) id = `${plugin}-${marketplace}`
  }
  return join(pluginsRoot(), 'data', id.replace(/[^A-Za-z0-9_-]/g, '-'))
}

// 解決の順：環境変数（HARNESS_DATA_DIR → CLAUDE_PLUGIN_DATA）→ SessionStart が引き渡した値 → 既定のパスの計算。
// Bash ツールから実行するコマンドには CLAUDE_PLUGIN_DATA が渡らないので、harness-note は 2 番目以降に頼る。
export function resolveDataDir() {
  const fromEnv = process.env.HARNESS_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA
  if (fromEnv && isAbsolute(fromEnv)) return { dir: resolve(fromEnv), source: 'env' }
  const handed = handoffDataDir()
  if (handed) return { dir: handed, source: 'handoff' }
  return { dir: defaultDataDir(), source: 'default' }
}

export function writeHandoff(data) {
  writeJson(join(data, HANDOFF), { plugin: PLUGIN, plugin_root: PLUGIN_ROOT, updated_at: iso() })
}

export function dirsFor(data, repoId) {
  const state = join(data, 'state', repoId)
  return {
    data,
    events: join(data, 'events', repoId),
    episodes: join(data, 'episodes', repoId),
    candidates: join(data, 'candidates', repoId),
    trial: join(data, 'trial', repoId),
    rules: join(data, 'trial', repoId, 'rules'),
    pending: join(data, 'pending', repoId),
    reports: join(data, 'reports', repoId),
    state,
    sessions: join(state, 'sessions'),
    auto: join(state, 'auto.json'),
    lock: join(state, 'lock.json'),
    heartbeat: join(state, 'heartbeat.json'),
  }
}

// hook と harness-note が共通で使う文脈。init していないリポジトリでは null。
// リポジトリは、セッションを始めた場所（CLAUDE_PROJECT_DIR）を先に見る。cwd を先に見ると、
// 入れ子の別のリポジトリへ cd しただけで、ロックや確認の対象から外れてしまうため。
// ただし cwd が同じリポジトリの worktree なら、そちらの根を使う（検証は、変更のある側で走らせる）。
export function makeContext(cwd, { sessionId = null } = {}) {
  const initialized = (start) => {
    const repo = start ? findRepo(start) : null
    const config = repo ? loadConfig(repo.root) : null
    return config ? { repo, config } : null
  }
  let found = null
  for (const start of [process.env.CLAUDE_PROJECT_DIR, cwd, process.cwd()]) {
    found = initialized(start)
    if (found) break
  }
  if (!found) return null
  const here = initialized(cwd)
  if (here && here.repo.id === found.repo.id) found = here
  const data = resolveDataDir()
  return {
    repo: found.repo,
    config: found.config,
    data: data.dir,
    dataSource: data.source,
    dirs: dirsFor(data.dir, found.repo.id),
    sessionId: sessionId ? safeId(sessionId) : null,
  }
}

// hook 用。HARNESS_DISABLE=1 と、init していないリポジトリでは null（＝何もしない）。
export function hookContext(input) {
  if (disabled()) return null
  return makeContext(input.cwd, { sessionId: input.session_id })
}

export function sessionDir(ctx, sessionId = ctx.sessionId) {
  return join(ctx.dirs.sessions, safeId(sessionId))
}

// ---- 排他 ----

// 複数のセッションが同じ状態ファイルを書き換えるときの、ごく短い排他。
export function withLock(dir, fn) {
  const lockDir = join(dir, '.lock')
  mkdirSync(dir, { recursive: true })
  const deadline = Date.now() + 3000
  for (;;) {
    try {
      mkdirSync(lockDir)
      break
    } catch {
      let age = 0
      try {
        age = Date.now() - statSync(lockDir).mtimeMs
      } catch {
        continue
      }
      if (age > 10000 || Date.now() > deadline) {
        rmSync(lockDir, { recursive: true, force: true })
        continue
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lockDir, { recursive: true, force: true })
  }
}

// ---- 生ログ ----

export function logEvent(ctx, event) {
  const record = { ts: iso(), session_id: ctx.sessionId, ...event }
  mkdirSync(ctx.dirs.events, { recursive: true })
  appendFileSync(join(ctx.dirs.events, `${dayOf()}.jsonl`), `${JSON.stringify(record)}\n`)
  return record
}

// since（ISO）以降の生ログを読む。日付ごとのファイルなので、since の日から今日までを開く。
export function readEvents(ctx, since) {
  const from = since ? dayOf(new Date(since)) : '0000-00-00'
  const out = []
  for (const file of listFiles(ctx.dirs.events, (f) => f.endsWith('.jsonl'))) {
    if (file.slice(0, 10) < from) continue
    let text = ''
    try {
      text = readFileSync(join(ctx.dirs.events, file), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const event = JSON.parse(line)
        if (!since || event.ts >= since) out.push(event)
      } catch {
        // 壊れた行は読み飛ばす
      }
    }
  }
  return out
}

// hook が最後に動いた時刻。記録が止まっていないかの判定に使う（生ログの行数では判定しない）。
export function heartbeat(ctx, kind) {
  try {
    const current = readJson(ctx.dirs.heartbeat, {}) || {}
    current[kind] = iso()
    writeJson(ctx.dirs.heartbeat, current)
  } catch {
    // 記録できなくても作業は止めない
  }
}

// ---- 自動改善のロック ----

// ロックのファイルを読む。2 時間たったものは無効と見なす。
// 読めないファイル（途中までの JSON など）は、更新から 2 時間のあいだ「誰かのロック」として扱う
// （broken: true）。ロックがないことにすると、書き込みの拒否が外れるため、拒否の側に倒す。
function readLockFile(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let lock = null
  try {
    lock = JSON.parse(text)
  } catch {
    // 下で broken として扱う
  }
  const valid = lock && typeof lock === 'object' && typeof lock.session_id === 'string' && lock.session_id
    && typeof lock.at === 'string' && !Number.isNaN(Date.parse(lock.at))
  if (!valid) {
    let mtime = 0
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      return null
    }
    if (Date.now() - mtime > LOCK_TTL_MS) return null
    return { broken: true, session_id: null, at: new Date(mtime).toISOString(), targets: [], done: {} }
  }
  if (now().getTime() - Date.parse(lock.at) > LOCK_TTL_MS) return null
  return { targets: [], done: {}, ...lock }
}

// このリポジトリのロック（なければ null）。
export function activeLock(ctx) {
  return readLockFile(ctx.dirs.lock)
}

// そのセッションが持っているロックを、データ領域のすべてのリポジトリから探す。
// ロックはセッション単位。別のリポジトリへ移っても、ロック中のセッションはロック中のまま。
export function sessionLock(data, sessionId) {
  if (!sessionId) return null
  const sid = safeId(sessionId)
  const base = join(data, 'state')
  for (const repoId of listFiles(base)) {
    const lock = readLockFile(join(base, repoId, 'lock.json'))
    if (lock && !lock.broken && lock.session_id === sid) return { repoId, lock }
  }
  return null
}

export function isLocked(ctx, sessionId = ctx.sessionId) {
  return Boolean(sessionLock(ctx.data, sessionId))
}

// hook がそのセッションを記録しているか（SessionStart か UserPromptSubmit が状態を残している）。
export function isKnownSession(ctx, sessionId) {
  return Boolean(sessionId) && existsSync(join(ctx.dirs.sessions, safeId(sessionId)))
}

// ---- frontmatter ----

// 失敗票・ルール・SKILL.md の先頭を読むための、YAML のごく一部の読み取り。
// 対応するのは「key: 値」「key: [a, b]」「key:（改行）  - a」と、# のコメントだけ。
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { data: null, keys: [], body: text }
  const data = {}
  const keys = []
  let listKey = null
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue
    const item = /^\s+-\s*(.*)$/.exec(rawLine)
    if (item && listKey) {
      data[listKey].push(scalar(item[1]))
      continue
    }
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(rawLine)
    if (!pair) {
      if (/^\s/.test(rawLine)) continue
      keys.push(rawLine.trim())
      continue
    }
    const [, key, rest] = pair
    keys.push(key)
    const value = stripComment(rest)
    if (value === '') {
      data[key] = []
      listKey = key
      continue
    }
    listKey = null
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value.slice(1, -1).split(',').map((v) => scalar(v)).filter((v) => v !== '')
    } else {
      data[key] = scalar(value)
    }
  }
  return { data, keys, body: text.slice(match[0].length) }
}

function stripComment(value) {
  const trimmed = value.trim()
  if (/^["']/.test(trimmed)) return trimmed
  return trimmed.replace(/\s+#.*$/, '').trim()
}

function scalar(value) {
  const v = String(value).trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    if (v.startsWith('"')) {
      try {
        return JSON.parse(v)
      } catch {
        return v.slice(1, -1)
      }
    }
    return v.slice(1, -1)
  }
  if (v === 'null' || v === '~') return null
  return v
}

export function lineCount(text) {
  const trimmed = String(text).replace(/\s+$/, '')
  return trimmed ? trimmed.split('\n').length : 0
}
