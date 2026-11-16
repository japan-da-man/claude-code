// どこで動くかの判定。ガードの早い判定（guard-harness.mjs の先頭）と、記録する側（core.mjs）が、
// この 1 つのモジュールを使う。判定を 2 か所に書くと、食い違ったときに「ガードは効くのに記録されない」
// 「除外したのに記録される」が起きるため。
// すべてのツール呼び出しで読み込まれるので、Node.js の標準だけを使い、ほかのモジュールを読み込まない。
//
//   - init はいらない。すべての git リポジトリで動く
//   - 止めたい場所は、~/.claude/self-improve/config.json の exclude に書く（そのパスと、その下のリポジトリ）
//   - ホームディレクトリそのもの（ホームを git で管理している場合）と、node_modules の中は、組み込みで除外する
//   - セッションを始めたリポジトリが除外されていれば、そのセッション全体を止める
//   - git リポジトリでない場所と、HARNESS_DISABLE=1 では、何もしない
//   - .git があるのに、git の共通ディレクトリを解決できないとき（commondir や、worktree の .git のファイルが壊れている）は、
//     上の階層へ探しに行かず、その場所をリポジトリとして扱う（閉じる側に倒す。書き換えただけで、ガードが外れないように）
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// ~/.claude に当たる場所。テストでは HARNESS_CLAUDE_HOME で一時ディレクトリに向ける。
// HARNESS_CLAUDE_HOME はテスト用なので、テストの印（HARNESS_TEST=1）があるときだけ読む（HARNESS_NOW と同じ扱い）。
// ふだんも読むと、環境変数 1 つで、user 側の置き場所（exclude、disable_defaults、失敗票）を別の場所へ向けられる。
export function claudeHome() {
  const forTest = process.env.HARNESS_TEST === '1' ? process.env.HARNESS_CLAUDE_HOME : null
  return resolve(forTest || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
}
// user 単位の設定・ガード・失敗票の置き場所。
export function userDir() {
  return join(claudeHome(), 'self-improve')
}
export function userConfigPath() {
  return join(userDir(), 'config.json')
}

export function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// 大文字小文字を区別しないファイルシステム（macOS、Windows の既定）か。区別しないなら、パスを比べる前に小文字にそろえる
// （exclude に ~/Work と書いて、実体が ~/work でも外れるように。ガードの書き込みの確認と同じ考え方）。
const foldsCase = () => process.platform === 'darwin' || process.platform === 'win32'
const fold = (path) => (foldsCase() ? path.toLowerCase() : path)

function real(path) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

// git の共通ディレクトリ（worktree でも本体と同じになる）。git コマンドは呼ばない。
// 解決できないとき（worktree の .git のファイルが読めない・形が違う、gitdir や commondir の先がない）は、
// 解決できたところまで（gitdir か、.git そのもの）を返す。null は返さない（上の階層へ探しに行かせないため）。
function commonDirOf(dotgit, stat) {
  const self = real(dotgit) ?? resolve(dotgit)
  let gitdir = self
  if (stat.isFile()) {
    let text = ''
    try {
      text = readFileSync(dotgit, 'utf8')
    } catch {
      return self
    }
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(text)
    if (!match) return self
    gitdir = real(resolve(dirname(dotgit), match[1]))
    if (!gitdir) return self
  }
  try {
    const common = readFileSync(join(gitdir, 'commondir'), 'utf8').trim()
    if (common) return real(resolve(gitdir, common)) ?? gitdir
  } catch {
    // commondir がなければ、その gitdir が共通ディレクトリ
  }
  return gitdir
}

// start から上へたどって、git リポジトリの根を探す。なければ null。
export function gitRootOf(start) {
  let dir = real(resolve(start || process.cwd()))
  if (!dir) return null
  for (;;) {
    const dotgit = join(dir, '.git')
    let stat = null
    try {
      stat = statSync(dotgit)
    } catch {
      // 上の階層を探す
    }
    // .git があれば、共通ディレクトリを解決できなくても、ここをリポジトリとする（git も、上の階層へは探しに行かない）。
    if (stat) return { root: dir, commonDir: commonDirOf(dotgit, stat) }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// ~ と ~/ で始まるパスを、ホームのパスに直す。
function expandTilde(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

// user の設定（~/.claude/self-improve/config.json）を読む。ここで見るのは、除外の一覧と、読めるかどうかだけ
// （ほかの項目は core.mjs が重ねる）。
//   exists   ファイルがある
//   error    読めない理由（JSON として読めない、オブジェクトでない、exclude を解釈できない）。あれば、記録と掃除を止める
//   raw      読めた中身（読めなければ {}）
//   exclude  除外するパス（絶対パス。実体のパスに直してある）。exclude に解釈できない値が混ざっていても、
//            正しく書けている値は入れる（その場所は除外する。除外したつもりの場所で、記録もガードも動かないように）
//   notes    知らせるだけのこと（exclude に書いたパスが見つからない、など）
export function readUserConfig() {
  const file = userConfigPath()
  const out = { file, exists: false, error: null, raw: {}, exclude: [], notes: [] }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    if (e?.code === 'ENOENT') return out
    return { ...out, exists: true, error: `読めません（${e.message}）` }
  }
  out.exists = true
  let raw
  try {
    raw = JSON.parse(text)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('オブジェクトではありません')
  } catch (e) {
    return { ...out, error: `JSON として読めません（${e.message}）` }
  }
  out.raw = raw
  if (raw.exclude === undefined) return out
  // exclude が配列でないときは、どこを止めたいのかが分からない。読めない設定と同じに扱う（どこも除外せず、記録を止める）。
  // 配列の一部の値だけを解釈できないときは、error を立てて記録を止めるが、正しく書けている値の除外は効かせる。
  if (!Array.isArray(raw.exclude)) return { ...out, error: 'exclude は、パスの配列で書いてください（例："exclude": ["~/work/client-x"]）' }
  const bad = []
  for (const entry of raw.exclude) {
    if (typeof entry !== 'string' || !entry.trim()) {
      bad.push(JSON.stringify(entry))
      continue
    }
    const path = expandTilde(entry.trim())
    if (!isAbsolute(path)) {
      bad.push(entry)
      continue
    }
    const actual = real(path)
    if (!actual) out.notes.push(`exclude の ${entry} が見つかりません（書き間違いでなければ、そのままで構いません）`)
    out.exclude.push(actual ?? resolve(path))
  }
  if (bad.length) {
    return { ...out, error: `exclude の ${bad.join('、')} を解釈できません。絶対パスか、~/ で始まるパスで書いてください` }
  }
  return out
}

// そのリポジトリを除外するか。除外するなら理由、しないなら null。
// exclude に書いたパスの下にあるリポジトリを除外する。worktree は、本体（git の共通ディレクトリ）が下にあれば除外する。
// 大文字小文字を区別しないファイルシステムでは、小文字にそろえて比べる。
export function excludedReason(repo, user) {
  const home = fold(real(homedir()) ?? resolve(homedir()))
  const root = fold(repo.root)
  const common = fold(repo.commonDir)
  if (root === home) return 'home'
  if (root.split(sep).includes('node_modules')) return 'node_modules'
  if (user.exclude.some((path) => isInside(fold(path), root) || isInside(fold(path), common))) return 'exclude'
  return null
}

// セッションのリポジトリを決める。セッションを始めた場所（CLAUDE_PROJECT_DIR。harness-note には、
// SessionStart が HARNESS_PROJECT_DIR として引き渡す）を先に見て、なければ cwd を見る。
// cwd を先に見ると、入れ子の別のリポジトリへ cd しただけで、ガードやロックの対象から外れてしまうため。
export function sessionRepo(cwd) {
  for (const start of [process.env.CLAUDE_PROJECT_DIR, process.env.HARNESS_PROJECT_DIR, cwd, process.cwd()]) {
    if (typeof start !== 'string' || !start) continue
    const repo = gitRootOf(start)
    if (repo) return repo
  }
  return null
}

// このツール呼び出し・この hook で、self-improve が動くかどうか。
//   active     動く（ガードを効かせる）
//   recording  記録と掃除もする（user の設定が読めないあいだは false。除外の一覧を信じられないため）
//   reason     動かない理由：disabled / no_repo / home / node_modules / exclude
export function resolveScope(cwd) {
  if (process.env.HARNESS_DISABLE === '1') return { active: false, recording: false, reason: 'disabled', repo: null, user: null }
  const repo = sessionRepo(cwd)
  if (!repo) return { active: false, recording: false, reason: 'no_repo', repo: null, user: null }
  const user = readUserConfig()
  const reason = excludedReason(repo, user)
  if (reason) return { active: false, recording: false, reason, repo, user }
  return { active: true, recording: !user.error, reason: null, repo, user }
}
