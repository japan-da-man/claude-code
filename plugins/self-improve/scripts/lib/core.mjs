// hook のスクリプトと harness-note が共有する土台。
// リポジトリの特定、設定の読み込み（初期値 → user の設定 → リポジトリごとの上書き）、データ領域の解決、ファイルの読み書き、生ログ。
// どこで動くかの判定は scope.mjs にある（ガードの早い判定と同じものを使う）。
// 外部の依存は使わない（Node.js 標準だけ）。ネットワークには出ない。
import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeHome, gitRootOf, isInside, readUserConfig, resolveScope, userDir } from './scope.mjs'

export { claudeHome, isInside, userDir }

export const PLUGIN = 'self-improve'
export const PLUGIN_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const NOTE_BIN = join(PLUGIN_ROOT, 'bin', 'harness-note')
export const LOCK_TTL_MS = 2 * 60 * 60 * 1000
export const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULT_CONFIG = {
  trial_review_days: 60,
  episode_retention_days: 90,
  // self-improve がセッション開始時に読み込ませる行数（試用ルール＋自分専用のルール）の目安。
  budget: { always_loaded_rule_lines: 50 },
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

// cwd から上へたどって .git を探す。リポジトリ ID は git の共通ディレクトリのパスから作るので、
// worktree でも同じ ID になる。git コマンドは呼ばない。
function describeRepo(found) {
  const common = found.commonDir
  const raw = basename(common) === '.git' ? basename(dirname(common)) : basename(common).replace(/\.git$/, '')
  const name = slug(raw)
  return { root: found.root, commonDir: common, name, id: `${name}-${sha(common)}` }
}
export function findRepo(start) {
  const found = gitRootOf(start)
  return found ? describeRepo(found) : null
}

// user 側の、リポジトリごとの置き場所（設定の上書き、ガード、自分専用のルール）。
// ~/.claude/self-improve/repos/<名前>/。同じ名前のリポジトリを分けたいときは、<名前>-<ID の英数字> のディレクトリを作れば、
// そちらを先に使う（harness-note status に、いま使っている場所が出る）。
export function userRepoDir(repo) {
  const byId = join(userDir(), 'repos', repo.id)
  return existsSync(byId) ? byId : join(userDir(), 'repos', repo.name)
}

// 人に見せるパス。ホームの下は ~ から書く（絶対パスをそのまま出さない）。
export function tildePath(path) {
  const home = homedir()
  const abs = resolve(path)
  if (abs === home) return '~'
  return isInside(home, abs) ? `~/${posix(relative(home, abs))}` : posix(abs)
}

// ---- 設定 ----

const count = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback)
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

// リポジトリの harness/config.json。ここから読むのは、検証コマンド（verify）だけ。
export function configPath(root) {
  return join(root, 'harness', 'config.json')
}

// JSON のファイルを 1 つ読む。なければ空。読めなければ error に理由を入れる。
function readLayer(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    return { exists: e?.code !== 'ENOENT', raw: {}, error: e?.code === 'ENOENT' ? null : e.message }
  }
  try {
    const raw = JSON.parse(text)
    if (!isObject(raw)) throw new Error('オブジェクトではありません')
    return { exists: true, raw, error: null }
  } catch (e) {
    return { exists: true, raw: {}, error: e.message }
  }
}

// 上の層の値で、下の層を上書きする（budget・candidates・auto・prune は、項目ごとに重ねる）。
function overlay(base, top) {
  const out = { ...base }
  for (const [key, value] of Object.entries(top)) {
    out[key] = isObject(value) && isObject(base[key]) ? { ...base[key], ...value } : value
  }
  return out
}

// 設定を重ねて読む。初期値 → user の設定（~/.claude/self-improve/config.json）
// → リポジトリごとの上書き（~/.claude/self-improve/repos/<名前>/config.json）の順。
// リポジトリの harness/config.json からは、検証コマンド（verify）だけを読む。リポジトリのファイルは、
// 共有されたり、プルで変わったりするので、仕組みの動き方（自動改善の間隔や上限など）は決めさせない。
// 読めない層は飛ばして、errors に理由を残す。
export function loadConfig(repo, user = readUserConfig()) {
  const errors = []
  const notes = [...user.notes]
  if (user.error) errors.push(`${tildePath(user.file)}：${user.error}。直すまで、記録と掃除を止めています（ガードは効いています）`)
  const overrideFile = join(userRepoDir(repo), 'config.json')
  const override = readLayer(overrideFile)
  if (override.error) errors.push(`${tildePath(overrideFile)} を読めません（${override.error}）。このリポジトリの上書きは使っていません`)
  const repoFile = readLayer(configPath(repo.root))
  if (repoFile.error) errors.push(`harness/config.json を読めません（${repoFile.error}）。検証コマンドは動いていません`)
  const ignored = Object.keys(repoFile.raw).filter((key) => key !== 'verify' && !key.startsWith('$') && key !== 'description')
  if (ignored.length) {
    notes.push(`harness/config.json の ${ignored.join('、')} は読みません（読むのは verify だけです）。${tildePath(overrideFile)} に移してください`)
  }

  const raw = overlay(overlay({}, user.raw), override.raw)
  const d = DEFAULT_CONFIG
  const categories = Array.isArray(raw.candidates?.categories) && raw.candidates.categories.every((c) => typeof c === 'string' && c)
    ? raw.candidates.categories
    : d.candidates.categories
  const verify = normalizeVerify(repoFile.raw.verify)
  return {
    errors,
    notes,
    files: { user: user.file, override: overrideFile, repo: configPath(repo.root) },
    trial_review_days: count(raw.trial_review_days, d.trial_review_days),
    episode_retention_days: count(raw.episode_retention_days, d.episode_retention_days),
    budget: {
      always_loaded_rule_lines: count(raw.budget?.always_loaded_rule_lines, d.budget.always_loaded_rule_lines),
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
    // 検証コマンドを実行してよいか（人が harness-note verify trust で許可した中身と一致するか）。
    verify_trust: verifyTrustState(repo, verify),
  }
}

// ---- 検証コマンドの許可 ----
// リポジトリの harness/config.json の verify は、クローンしただけのリポジトリにもありうる。初めて見る中身は実行せず、
// 人が harness-note verify trust で許可したとき、その中身（正規化した JSON）のハッシュを user 側に記録する。
// 記録と一致するときだけ実行する。プルなどで中身が変われば、もう一度許可が要る。
// 記録の置き場所は ~/.claude/self-improve/repos/<名前>/verify-trust.json。同じ名前のリポジトリが置き場所を共有しても
// 混ざらないよう、リポジトリ ID ごとに持つ（リポジトリを移すと ID が変わり、もう一度許可が要る）。

// 実行する形にそろえた検証コマンドの一覧（name、run、timeout_sec）。
export function normalizeVerify(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter((v) => v && typeof v.run === 'string' && v.run.trim()).map((v, i) => ({
    name: typeof v.name === 'string' && v.name ? v.name : `verify-${i + 1}`,
    run: v.run,
    timeout_sec: count(v.timeout_sec, 240) || 240,
  }))
}
export function verifyHash(verify) {
  return sha(JSON.stringify(verify.map(({ name, run, timeout_sec }) => ({ name, run, timeout_sec }))), 64)
}
export function verifyTrustFile(repo) {
  return join(userRepoDir(repo), 'verify-trust.json')
}
function readVerifyTrust(repo) {
  const record = readJson(verifyTrustFile(repo), null)?.repos?.[repo.id]
  return isObject(record) && typeof record.hash === 'string' ? record : null
}
//   hash     いまの中身のハッシュ（検証コマンドがなければ null）
//   trusted  許可した中身と一致する
//   changed  許可した記録はあるが、中身が変わっている
function verifyTrustState(repo, verify) {
  if (!verify.length) return { hash: null, trusted: false, changed: false }
  const hash = verifyHash(verify)
  const record = readVerifyTrust(repo)
  return { hash, trusted: record?.hash === hash, changed: Boolean(record) && record.hash !== hash }
}
// いまの中身を許可したと記録する（harness-note verify trust。人だけの操作）。
export function recordVerifyTrust(ctx) {
  const file = verifyTrustFile(ctx.repo)
  const current = readJson(file, null)
  const repos = isObject(current?.repos) ? current.repos : {}
  repos[ctx.repo.id] = { hash: verifyHash(ctx.config.verify), trusted_at: iso(), repo: ctx.repo.name, verify: ctx.config.verify }
  writeJson(file, { repos })
  return file
}

// 許可されていない検証コマンドの知らせ（セッション開始時と、直接実行したとき）。
export function untrustedVerifyMessage(ctx) {
  const list = ctx.config.verify.map((v) => v.name).join('、')
  const why = ctx.config.verify_trust.changed ? '前に許可したときから中身が変わっているので' : 'まだ許可されていないので'
  return `このリポジトリの harness/config.json に検証コマンド（${ctx.config.verify.length} 件：${list}）がありますが、${why}、実行していません。中身を確かめて、実行してよければ、Claude に「検証コマンドを許可して」と頼んでください（harness-note verify trust。実行するコマンドの一覧を見せてから記録します）。`
}

// ---- データ領域 ----

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
    // どのリポジトリのデータかの控え（1 日 1 回の掃除が、リポジトリごとの保持期間を引くのに使う）。
    repoInfo: join(state, 'repo.json'),
    // user 単位のもの（全リポジトリで共有する）。好みの候補と、知らせ・掃除の状態。
    prefs: join(data, 'candidates', USER_SCOPE),
    userState: join(data, 'state', USER_SCOPE),
  }
}
// データ領域の中で、user 単位のものを置くディレクトリ名（リポジトリ ID と重ならない）。
export const USER_SCOPE = '_user'

// hook と harness-note が共通で使う文脈。動かない場所（git リポジトリでない、除外してある、HARNESS_DISABLE=1）では null。
// リポジトリは、セッションを始めた場所を先に見る（scope.mjs）。ただし cwd が同じリポジトリの worktree なら、
// そちらの根を使う（検証は、変更のある側で走らせる）。
export function makeContext(cwd, { sessionId = null } = {}) {
  const scope = resolveScope(cwd)
  if (!scope.active) return null
  let found = scope.repo
  const here = gitRootOf(cwd || process.cwd())
  if (here && here.commonDir === found.commonDir) found = here
  const repo = describeRepo(found)
  const data = resolveDataDir()
  return {
    repo,
    config: loadConfig(repo, scope.user),
    data: data.dir,
    dataSource: data.source,
    dirs: dirsFor(data.dir, repo.id),
    // user 側の置き場所（~/.claude/self-improve/ の下）。
    user: { dir: userDir(), repoDir: userRepoDir(repo), incidents: join(userDir(), 'incidents') },
    // user の設定が読めないあいだは false。ガードは効かせたまま、記録と掃除を止める。
    recording: scope.recording,
    sessionId: sessionId ? safeId(sessionId) : null,
  }
}

// 動かない理由を、人に伝える文にする（harness-note 用）。
export function inactiveReason(cwd) {
  const scope = resolveScope(cwd)
  if (scope.active) return null
  return {
    disabled: 'HARNESS_DISABLE=1 なので、self-improve は止まっています',
    no_repo: 'git リポジトリではありません。self-improve は、git リポジトリの中で動きます',
    home: 'ホームディレクトリそのものは、self-improve の対象から外してあります',
    node_modules: 'node_modules の中は、self-improve の対象から外してあります',
    exclude: `このリポジトリは、~/.claude/self-improve/config.json の exclude で、self-improve の対象から外してあります`,
  }[scope.reason]
}

// hook 用。動かない場所では null（＝何もしない）。
export function hookContext(input) {
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
  // user の設定が読めないあいだは、記録しない（除外の一覧を信じられないため）。
  if (ctx.recording === false) return record
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
  if (ctx.recording === false) return
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
