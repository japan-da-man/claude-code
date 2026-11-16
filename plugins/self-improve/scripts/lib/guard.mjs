// ガードの判定（PreToolUse。すべてのツールを見る）。
//   禁止操作                         → 拒否（deny）
//   ハーネスのファイルへの書き込み   → 確認（ask）
//   自動改善のセッション（ロック中） → 通すツールの一覧で判定し、それ以外はすべて拒否する（確認は出さない）
//   ロックを試みたセッション         → ロックが外れたあと・始まらなかったあとも、書き込みに確認を挟む
// harness-note の呼び出しは、--session が hook の本物の session_id と一致するものだけを通す。
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { PLUGIN_ROOT, activeLock, claudeHome, isInside, isLocked, posix, realish, tildePath, userDir } from './core.mjs'
import { parseArgs } from './args.mjs'
import { commandOf, isHarnessNoteCommand, isHarnessNoteSegment, isNonChanging, isWrappedHarnessNote, parseBash, skeleton, writeTargets } from './bash.mjs'
import { isAutoSession } from './auto.mjs'
import { isTrialSkillPath } from './trial.mjs'

export const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
// 自動改善のセッション（ロック中）で通すツール。Bash は、harness-note の単純な呼び出しだけ。
// Skill は、読み直しのための self-improve:auto-improve だけ（ほかのスキルは、本文の !`cmd` や context: fork で、
// PreToolUse の外でコマンドやサブエージェントを動かしうる）。
export const LOCK_ALLOWED_TOOLS = new Set(['Read', 'Grep', 'Glob'])
export const LOCK_ALLOWED_SKILL = 'self-improve:auto-improve'
// ガード自身の書式の検査（harness-note の呼び出し方）。この拒否は、失敗の信号には数えない。
export const NOTE_CALL_RULE = 'harness-note-call'
export const DEFAULT_GUARDS = join(PLUGIN_ROOT, 'guards.default.json')

function compile(source, flags, errors, where) {
  if (typeof source !== 'string' || !source) return null
  try {
    return new RegExp(source, typeof flags === 'string' ? flags : '')
  } catch (e) {
    errors.push(`${where}：正規表現を読めません（${e.message}）`)
    return null
  }
}

// JSON のファイルを読む。ないときは null、読めないときは error を返す（読めないことを、黙って「ない」にしない）。
function readGuardFile(file) {
  if (!existsSync(file)) return { value: null, error: null }
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { value: null, error: 'オブジェクトではありません' }
    return { value, error: null }
  } catch (e) {
    return { value: null, error: e.message }
  }
}

// ガードの定義を置ける 4 か所。すべて読み、すべて効かせる。
//   default    共通リスト（プラグインに同梱）
//   user       user 全体（~/.claude/self-improve/guards.json）。どのリポジトリでも効かせたい、自分の決まり
//   user-repo  user のリポジトリごと（~/.claude/self-improve/repos/<名前>/guards.json）。リポジトリには置かない、自分だけの決まり
//   repo       リポジトリの harness/guards.json。チームで共有する決まり
export function guardFiles(ctx) {
  const mine = join(ctx.user.dir, 'guards.json')
  const mineHere = join(ctx.user.repoDir, 'guards.json')
  return [
    { source: 'default', file: DEFAULT_GUARDS, label: 'guards.default.json' },
    { source: 'user', file: mine, label: tildePath(mine) },
    { source: 'user-repo', file: mineHere, label: tildePath(mineHere) },
    { source: 'repo', file: join(ctx.repo.root, 'harness', 'guards.json'), label: 'harness/guards.json' },
  ]
}

// ルールは 2 種類：pattern（Bash のコマンドに当てる。文字列か、その配列）と path（書き込み先のパスに当てる）。
// decision が "ask" のルールは、拒否ではなく確認を挟む。
// 共通リストのルールを外せる（disable_defaults）のは、user 側のファイルだけ。リポジトリのファイルは、共有されたり
// プルで変わったりするので、足すことはできても、共通リストを外すことはできない。
// 読めないファイルは、黙って「ない」にせず、errors に残す（そのファイルのガードが効いていないことを知らせる）。
export function loadGuards(ctx) {
  const errors = []
  const notes = []
  const loaded = guardFiles(ctx).map((entry) => {
    const read = readGuardFile(entry.file)
    if (read.error) errors.push(`${entry.label} を読めません（${read.error}）。このファイルのガードは、直すまで効きません`)
    return { ...entry, value: read.value ?? {} }
  })
  const off = new Set()
  for (const { source, label, value } of loaded) {
    const list = Array.isArray(value.disable_defaults) ? value.disable_defaults : []
    if (!list.length) continue
    if (source === 'repo') {
      notes.push(`${label} の disable_defaults は読みません（共通リストを外せるのは、user 側のファイルだけです）。${loaded[2].label} に移してください`)
    } else {
      for (const id of list) off.add(id)
    }
  }
  const rules = []
  const protect = []
  for (const { source, label, value } of loaded) {
    for (const raw of Array.isArray(value.rules) ? value.rules : []) {
      if (source === 'default' && off.has(raw?.id)) continue
      const where = `${label} の ${raw?.id ?? '（id なし）'}`
      if (!raw || !raw.id || !raw.message) {
        errors.push(`${where}：id と message（直し方を 1 行）が必要です`)
        continue
      }
      const patterns = (Array.isArray(raw.pattern) ? raw.pattern : [raw.pattern]).map((p) => compile(p, raw.flags, errors, where)).filter(Boolean)
      const path = compile(raw.path, raw.flags, errors, where)
      if (!patterns.length && !path) {
        if (!raw.pattern && !raw.path) errors.push(`${where}：pattern か path が必要です`)
        continue
      }
      rules.push({ ...raw, source, file: label, patterns, path, except: compile(raw.except, raw.flags, errors, where), decision: raw.decision === 'ask' ? 'ask' : 'deny' })
    }
    if (source !== 'default') {
      (Array.isArray(value.protect) ? value.protect : []).forEach((p, i) => {
        const re = compile(p, 'i', errors, `${label} の protect[${i}]`)
        if (re) protect.push(re)
      })
    }
  }
  return { rules, protect, errors, notes }
}

// ---- 確認を挟むパス ----

// 大文字小文字を区別しないファイルシステム（macOS など）では CLAUDE.MD も同じファイルなので、小文字にそろえて比べる。
const HARNESS_FILES = new Set(['harness/config.json', 'harness/guards.json', 'harness/guards.test.json'])
const PROTECTED_DIRS = new Set(['harness', '.claude', '.claude/rules', '.claude/skills'])
const LINTER_CONFIG = /(^|\/)(\.eslintrc(\.[a-z]+)?|eslint\.config\.[a-z]+|biome\.jsonc?|\.oxlintrc\.json|\.?ruff\.toml|\.flake8|\.pylintrc|\.rubocop\.yml|\.golangci\.ya?ml|\.swiftlint\.yml|\.stylelintrc(\.[a-z]+)?|stylelint\.config\.[a-z]+|\.?clippy\.toml|detekt\.ya?ml)$/

export function protectedKind(rel, protect = []) {
  const lower = rel.toLowerCase()
  if (HARNESS_FILES.has(lower)) return 'ハーネスの設定'
  if (lower.startsWith('.claude/rules/')) return '昇格済みのルール'
  if (lower.startsWith('.claude/skills/')) return 'Skill'
  if (/(^|\/)claude(\.local)?\.md$/.test(lower)) return 'CLAUDE.md'
  if (LINTER_CONFIG.test(lower)) return 'リンター設定'
  if (protect.some((re) => re.test(rel))) return 'このリポジトリで保護しているファイル'
  return null
}

// ~ と $HOME で始まるパスを、ホームのパスに直す（Bash のコマンドの語は、展開の前の文字のまま届く）。
export function expandHome(raw) {
  const path = String(raw)
  const match = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(path)
  return match ? join(homedir(), path.slice(match[1].length)) : path
}

// ログやメッセージに出すパス。リポジトリの外は、ホームを ~ に直す（絶対パスをそのまま残さない）。
const displayPath = tildePath

// user 側のファイルか（~/.claude/self-improve/ の下と、~/.claude/CLAUDE.md）。書き込みには確認を挟む。
// 名前と実体の両方で見て、大文字小文字は区別しない（区別しないファイルシステムで、別の綴りから書けるため）。
function userSideKind(at) {
  const lower = (p) => p.toLowerCase()
  const paths = at.all.map(lower)
  const under = (base) => [base, realish(base)].map(lower).some((b) => paths.some((p) => p === b || p.startsWith(`${b}/`) || p.startsWith(`${b}\\`)))
  const same = (file) => [file, realish(file)].map(lower).some((f) => paths.includes(f))
  if (under(userDir())) return 'self-improve の user 側のファイル（設定・ガード・失敗票・自分専用のルール）'
  if (same(join(claudeHome(), 'CLAUDE.md'))) return 'user の CLAUDE.md'
  return null
}

// 実体が同じなら、その名前への書き込みとして扱うファイル（CLAUDE.md -> AGENTS.md のようなリンク）。
const LINKABLE = ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', 'harness/config.json', 'harness/guards.json', 'harness/guards.test.json']

// 書き込み先を、名前（リンクをたどらないパス）と実体（リンクをたどったパス）の両方で表す。
// どちらか一方だけで判定すると、シンボリックリンクで保護を外せる
// （CLAUDE.md がリンクなら実体は別の名前になり、リンク先のディレクトリは名前が別になる）。
//   abs   名前のパス（cd の移動先として使う）
//   all   名前と実体の絶対パス
//   rels  リポジトリの根からの相対パス（名前、実体、同じ実体を指す保護対象の名前）
function locate(ctx, raw, cwd) {
  const path = expandHome(raw)
  const name = isAbsolute(path) ? resolve(path) : resolve(cwd, path)
  const real = realish(name)
  const root = ctx.repo.root
  const rels = []
  const add = (rel) => {
    if (rel !== null && !rels.includes(rel)) rels.push(rel)
  }
  if (isInside(root, name)) {
    add(posix(relative(root, name)))
  } else {
    // リポジトリそのものをリンク経由で開いているとき：名前のパスの祖先のうち、実体がリポジトリの根に当たるものを探す。
    const tail = []
    for (let dir = name; ; ) {
      const parent = dirname(dir)
      if (parent === dir) break
      tail.unshift(basename(dir))
      dir = parent
      if (realish(dir) === root) {
        add(tail.join('/'))
        break
      }
    }
  }
  if (isInside(root, real)) add(posix(relative(root, real)))
  for (const alias of LINKABLE) {
    const file = join(root, alias)
    try {
      if (lstatSync(file).isSymbolicLink() && realish(file) === real) add(alias)
    } catch {
      // その名前のファイルがなければ、見ない
    }
  }
  const all = name === real ? [name] : [name, real]
  return { abs: name, all, rels, rel: rels[0] ?? null, subject: rels[0] ?? displayPath(real) }
}

const LOCKED_MESSAGE = '自動改善のセッションでは、Read・Grep・Glob と harness-note 以外のツールは使えません（ファイルへの書き込み、ほかのコマンド、MCP のツール、サブエージェントの起動を含みます）。読むのは Read / Grep / Glob、書き込みは harness-note だけを使ってください。リポジトリのファイルを変える案は、harness-note pending add --proposal-kind で報告に載せてください。'
const BROKEN_MESSAGE = '自動改善のロックのファイル（lock.json）を読めません。誰かが実行中かどうかを確かめられないので、書き込みを拒否しています。2 時間たつと解けます。急ぐときは、人が HARNESS_DISABLE=1 で起動してください。'
const AFTER_AUTO = 'このセッションは、自動改善（auto-improve）を呼び出したセッションです。ロックが外れたあと・始まらなかったあとも、書き込みには確認を挟みます（無人のセッションが、そのまま作業を続けないようにするため）。作業を続けるなら、新しいセッションで行ってください（self-improve）。'

// 書き込めない場所か。名前と実体のどちらかが当たれば、拒否する。
function locationDeny(ctx, at) {
  const inside = (base) => at.all.some((abs) => isInside(base, abs) || isInside(realish(base), abs))
  if (inside(PLUGIN_ROOT)) {
    return { rule: 'plugin-files', message: 'self-improve プラグイン自身のファイルは書き換えられません。決まりを変えたいときは、~/.claude/self-improve/ の設定やガードか、リポジトリの harness/ を変えてください。' }
  }
  if (inside(ctx.data)) {
    return { rule: 'harness-data', message: 'プラグインのデータ領域は、harness-note コマンドだけが書き込みます。試用ルールや改善候補は harness-note で読み書きしてください。' }
  }
  if (at.all.some(isTrialSkillPath)) {
    return { rule: 'trial-skill', message: '試用 Skill は、harness-note コマンドだけが書き込みます。直すときは /self-improve:review を使ってください。' }
  }
  return null
}

const allow = { decision: 'allow' }
const deny = (rule, message, target) => ({ decision: 'deny', rule, message, target })
const ask = (rule, message, target) => ({ decision: 'ask', rule, message, target })
const askProtected = (kind, subject) =>
  ask('harness-files', `${kind}（${subject}）への書き込みです。ハーネスの変更は、差分を確かめてから承認してください（self-improve）。`, subject)

// パスのルールは、名前と実体のどちらの相対パスに当たっても効く。
function matchPathRule(guards, at) {
  const subjects = at.rels.length ? at.rels : [at.subject]
  return guards.rules.find((r) => r.path && subjects.some((s) => r.path.test(s) && !(r.except && r.except.test(s)))) ?? null
}
const protectedOf = (at, protect) => at.rels.map((rel) => protectedKind(rel, protect)).find(Boolean) ?? null
// どのファイルのルールかを、結果に残す（拒否の記録に入れる）。
const byRule = (rule, target) => ({
  ...(rule.decision === 'ask'
    ? ask(rule.id, `${rule.message}（ルール：${rule.id}。確認のうえで進めます）`, target)
    : deny(rule.id, rule.message, target)),
  source: rule.file,
})

// ---- harness-note の呼び出しの確かめ ----

// コマンドの中の harness-note の呼び出しを確かめる。strict は自動改善のセッション（ロック中）。
//   - harness-note の引数は、ガードから全部見えていなければならない（変数の展開やコマンド置換は使えない）
//   - --session があるなら、hook の session_id と一致していること（ほかのセッションを名乗らせない）
//   - strict：コマンド全体が harness-note の単純な呼び出しだけで、どれにも一致する --session がちょうど 1 つ付いていること
//   - requireSession：harness-note の呼び出しに、一致する --session がちょうど 1 つ付いていること
//     （ロックを試みたセッションが、ロックが外れたあとに --session を省いて、別のセッションと推定されるのを防ぐ）
// 問題がなければ null、あれば理由を返す。
export function harnessNoteProblem(command, sessionId, { strict = false, requireSession = false, cwd = null } = {}) {
  const parsed = parseBash(command)
  // ほかのコマンドで包んだ呼び出し（command / env / node …/scripts/note.mjs など）は、引数を確かめられないので通さない。
  const isNoteScript = (path) => {
    const abs = resolve(cwd ?? process.cwd(), path)
    return !existsSync(abs) || existsSync(join(abs, '..', '..', 'bin', 'harness-note'))
  }
  if (parsed.segments.some((s) => isWrappedHarnessNote(s, isNoteScript))) {
    return 'harness-note は、ほかのコマンド（command、env、node、bash など）で包まずに、パスも付けずに、harness-note … の形で直接呼んでください'
  }
  const calls = parsed.segments.filter(isHarnessNoteCommand)
  if (!strict && !calls.length) return null
  if (parsed.subst || parsed.uncertain) {
    return 'コマンド置換や、読み取りの難しい書き方（$\'…\'、${…@…}、区切りが単純でないヒアドキュメントなど）は使えません。harness-note の引数は、値をそのまま書いてください（長い文は、区切りを引用したヒアドキュメント <<\'EOF\' で渡します）'
  }
  if (strict && (!parsed.segments.length || calls.length !== parsed.segments.length)) return 'harness-note 以外のコマンドは実行できません'
  for (const segment of calls) {
    const { assigns, args } = commandOf(segment)
    if (assigns.length) return 'harness-note の前に環境変数を置くことはできません（データの置き場所やセッションを差し替えられないようにするため）'
    if (!isHarnessNoteSegment(segment)) return 'harness-note の出力をファイルへ書き出すことはできません'
    // リダイレクト先（ヒアストリング <<< を含む）の語も、引数と同じに見る。
    const words = [...segment.words, ...segment.redirects]
    if (words.some((w) => w.expands)) return 'harness-note の引数では、変数の展開（$…）は使えません。値をそのまま書いてください（$ を含む文は単一引用符で囲みます）'
    // 引用の外の { } * ? [ ] ~ は、bash が語を作り替える（{--session=x,--key} は 2 語になり、--session の照合を外せる）。
    if (words.some((w) => w.special)) return 'harness-note の引数では、引用の外の { } * ? [ ] ~ は使えません（bash が語を作り替えるため）。これらを含む文は、単一引用符で囲んでください'
    let sessions
    try {
      sessions = (parseArgs(args).flags.session ?? []).map(String)
    } catch {
      return '--session の値がありません'
    }
    if (sessions.some((s) => s !== sessionId)) return `--session が、このセッションの ID と違います。ほかのセッションを名乗ることはできません（このセッションは --session ${sessionId}）`
    if ((strict || requireSession) && sessions.length !== 1) return `harness-note には、--session ${sessionId} をちょうど 1 つ付けてください`
  }
  return null
}

// MCP のツールやサブエージェントの起動など、外へ働きかけるツール（ロックを試みたセッションでは確認を挟む）。
const actsOutside = (tool) => /^mcp__/.test(tool) || ['Agent', 'Task', 'WebFetch', 'CronCreate', 'ScheduleWakeup'].includes(tool)

// PreToolUse の入力を受けて、allow / deny / ask を返す。
export function evaluate(ctx, input) {
  const tool = String(input.tool_name ?? '')
  const ti = input.tool_input ?? {}
  const cwd = input.cwd || ctx.repo.root
  const sid = ctx.sessionId
  const isFile = FILE_TOOLS.has(tool)
  const isBash = tool === 'Bash'
  const command = isBash ? String(ti.command ?? '') : ''

  // 1. 自動改善のセッション（ロック中）と、読めないロック：通すツールの一覧で判定する。
  const repoLock = activeLock(ctx)
  const locked = isLocked(ctx)
  if (locked || repoLock?.broken) {
    if (LOCK_ALLOWED_TOOLS.has(tool)) return allow
    if (tool === 'Skill' && String(ti.skill ?? '').replace(/^\//, '') === LOCK_ALLOWED_SKILL) return allow
    const message = locked ? LOCKED_MESSAGE : BROKEN_MESSAGE
    if (isBash) {
      const problem = harnessNoteProblem(command, sid, { strict: true, cwd })
      return problem ? deny('auto-session', `${problem}。${message}`, command.slice(0, 200)) : allow
    }
    return deny('auto-session', message, tool)
  }

  // 2. 関係のないツールは、ここで抜ける（ロックを試みたセッションだけ、外へ働きかけるツールに確認を挟む）。
  if (!isFile && !isBash) {
    if (actsOutside(tool) && isAutoSession(ctx)) return ask('auto-session-after', AFTER_AUTO, tool)
    return allow
  }

  const guards = loadGuards(ctx)
  let verdict = allow
  // 確認（ask）は、あとから拒否（deny）が見つかれば上書きされる。
  const consider = (next) => {
    if (next.decision === 'deny') return next
    if (verdict.decision === 'allow') verdict = next
    return null
  }

  if (isFile) {
    const raw = ti.file_path ?? ti.notebook_path
    if (typeof raw !== 'string' || !raw) return allow
    const at = locate(ctx, raw, cwd)
    const location = locationDeny(ctx, at)
    if (location) return deny(location.rule, location.message, at.subject)
    const rule = matchPathRule(guards, at)
    if (rule) {
      const stop = consider(byRule(rule, at.subject))
      if (stop) return stop
    }
    const kind = protectedOf(at, guards.protect) ?? userSideKind(at)
    if (kind) consider(askProtected(kind, at.subject))
    if (verdict.decision === 'allow' && isAutoSession(ctx)) return ask('auto-session-after', AFTER_AUTO, at.subject)
    return verdict
  }

  if (!command.trim()) return allow
  const problem = harnessNoteProblem(command, sid, { cwd, requireSession: isAutoSession(ctx) })
  if (problem) return deny(NOTE_CALL_RULE, problem, command.slice(0, 200))

  const parsed = parseBash(command)
  // 読み取りに自信のない書き方があるときだけ、元の文字列にも当てる。
  // コマンド置換は中身まで読んでいるので、置換があるだけでは全文に当てない
  // （git commit -m "$(cat <<'EOF' … EOF)" && git log -n 3 を、commit の -n と取り違えないため）。
  const subjects = parsed.segments.map(skeleton)
  if (parsed.uncertain) subjects.push(command)
  for (const rule of guards.rules) {
    if (!rule.patterns.length) continue
    const hit = subjects.find((s) => rule.patterns.some((re) => re.test(s)) && !(rule.except && rule.except.test(s)))
    if (hit) {
      const stop = consider(byRule(rule, hit.slice(0, 200)))
      if (stop) return stop
    }
  }
  const targets = []
  let here = cwd
  for (const entry of writeTargets(command)) {
    if (entry.cd) here = locate(ctx, entry.cd, here).abs
    targets.push(...entry.tokens.map((token) => locate(ctx, token, here)))
  }
  for (const at of targets) {
    const location = locationDeny(ctx, at)
    if (location) return deny(location.rule, location.message, at.subject)
    const rule = matchPathRule(guards, at)
    if (rule) {
      const stop = consider(byRule(rule, at.subject))
      if (stop) return stop
    }
  }
  for (const at of targets) {
    const kind = at.rels.some((rel) => PROTECTED_DIRS.has(rel.toLowerCase())) ? 'ハーネスのディレクトリ' : protectedOf(at, guards.protect) ?? userSideKind(at)
    if (kind) consider(askProtected(kind, at.subject))
  }
  if (verdict.decision === 'allow' && !isNonChanging(command) && isAutoSession(ctx)) return ask('auto-session-after', AFTER_AUTO, command.slice(0, 200))
  return verdict
}
