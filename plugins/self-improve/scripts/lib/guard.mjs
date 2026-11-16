// ガードの判定（PreToolUse。すべてのツールを見る）。
//   禁止操作                         → 拒否（deny）
//   ハーネスのファイルへの書き込み   → 確認（ask）
//   自動改善のセッション（ロック中） → 通すツールの一覧で判定し、それ以外はすべて拒否する（確認は出さない）
//   ロックを試みたセッション         → ロックが外れたあと・始まらなかったあとも、書き込みに確認を挟む
// harness-note の呼び出しは、--session が hook の本物の session_id と一致するものだけを通す。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { PLUGIN_ROOT, activeLock, isInside, isLocked, posix, realish } from './core.mjs'
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

// 共通リスト（プラグインの初期値）と、リポジトリ固有の harness/guards.json を合わせる。
// ルールは 2 種類：pattern（Bash のコマンドに当てる。文字列か、その配列）と path（書き込み先のパスに当てる）。
// decision が "ask" のルールは、拒否ではなく確認を挟む。
export function loadGuards(repoRoot) {
  const errors = []
  const defaults = readGuardFile(DEFAULT_GUARDS)
  if (defaults.error) errors.push(`guards.default.json を読めません（${defaults.error}）`)
  const repo = readGuardFile(join(repoRoot, 'harness', 'guards.json'))
  if (repo.error) errors.push(`harness/guards.json を読めません（${repo.error}）。このリポジトリのガードは、直すまで効きません`)
  const own = repo.value ?? {}
  const off = new Set(Array.isArray(own.disable_defaults) ? own.disable_defaults : [])
  const rules = []
  const sources = [
    ...(defaults.value?.rules ?? []).filter((r) => !off.has(r.id)).map((r) => ({ ...r, source: 'default' })),
    ...(Array.isArray(own.rules) ? own.rules : []).map((r) => ({ ...r, source: 'repo' })),
  ]
  for (const rule of sources) {
    const where = `${rule.source === 'default' ? 'guards.default.json' : 'harness/guards.json'} の ${rule.id ?? '（id なし）'}`
    if (!rule.id || !rule.message) {
      errors.push(`${where}：id と message（直し方を 1 行）が必要です`)
      continue
    }
    const patterns = (Array.isArray(rule.pattern) ? rule.pattern : [rule.pattern]).map((p) => compile(p, rule.flags, errors, where)).filter(Boolean)
    const path = compile(rule.path, rule.flags, errors, where)
    if (!patterns.length && !path) {
      if (!rule.pattern && !rule.path) errors.push(`${where}：pattern か path が必要です`)
      continue
    }
    rules.push({ ...rule, patterns, path, except: compile(rule.except, rule.flags, errors, where), decision: rule.decision === 'ask' ? 'ask' : 'deny' })
  }
  const protect = (Array.isArray(own.protect) ? own.protect : []).map((p, i) => compile(p, 'i', errors, `harness/guards.json の protect[${i}]`)).filter(Boolean)
  return { rules, protect, errors }
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

function locate(ctx, raw, cwd) {
  let path = String(raw)
  if (path === '~' || path.startsWith('~/')) path = join(homedir(), path.slice(1))
  const abs = realish(isAbsolute(path) ? path : resolve(cwd, path))
  const rel = isInside(ctx.repo.root, abs) ? posix(relative(ctx.repo.root, abs)) : null
  return { abs, rel, subject: rel ?? posix(abs) }
}

const LOCKED_MESSAGE = '自動改善のセッションでは、Read・Grep・Glob と harness-note 以外のツールは使えません（ファイルへの書き込み、ほかのコマンド、MCP のツール、サブエージェントの起動を含みます）。読むのは Read / Grep / Glob、書き込みは harness-note だけを使ってください。リポジトリのファイルを変える案は、harness-note pending add --proposal-kind で報告に載せてください。'
const BROKEN_MESSAGE = '自動改善のロックのファイル（lock.json）を読めません。誰かが実行中かどうかを確かめられないので、書き込みを拒否しています。2 時間たつと解けます。急ぐときは、人が HARNESS_DISABLE=1 で起動してください。'
const AFTER_AUTO = 'このセッションは、自動改善（auto-improve）を呼び出したセッションです。ロックが外れたあと・始まらなかったあとも、書き込みには確認を挟みます（無人のセッションが、そのまま作業を続けないようにするため）。作業を続けるなら、新しいセッションで行ってください（self-improve）。'

function locationDeny(ctx, abs) {
  if (isInside(PLUGIN_ROOT, abs)) {
    return { rule: 'plugin-files', message: 'self-improve プラグイン自身のファイルは書き換えられません。ハーネスの決まりを変えたいときは、適用先のリポジトリの harness/ を変えてください。' }
  }
  if (isInside(realish(ctx.data), abs)) {
    return { rule: 'harness-data', message: 'プラグインのデータ領域は、harness-note コマンドだけが書き込みます。試用ルールや改善候補は harness-note で読み書きしてください。' }
  }
  if (isTrialSkillPath(abs)) {
    return { rule: 'trial-skill', message: '試用 Skill は、harness-note コマンドだけが書き込みます。直すときは /self-improve:review を使ってください。' }
  }
  return null
}

const allow = { decision: 'allow' }
const deny = (rule, message, target) => ({ decision: 'deny', rule, message, target })
const ask = (rule, message, target) => ({ decision: 'ask', rule, message, target })
const askProtected = (kind, subject) =>
  ask('harness-files', `${kind}（${subject}）への書き込みです。ハーネスの変更は、差分を確かめてから承認してください（self-improve）。`, subject)

function matchPathRule(guards, subject) {
  return guards.rules.find((r) => r.path && r.path.test(subject) && !(r.except && r.except.test(subject))) ?? null
}
const byRule = (rule, target) => (rule.decision === 'ask'
  ? ask(rule.id, `${rule.message}（ルール：${rule.id}。確認のうえで進めます）`, target)
  : deny(rule.id, rule.message, target))

// ---- harness-note の呼び出しの確かめ ----

// コマンドの中の harness-note の呼び出しを確かめる。strict は自動改善のセッション（ロック中）。
//   - harness-note の引数は、ガードから全部見えていなければならない（変数の展開やコマンド置換は使えない）
//   - --session があるなら、hook の session_id と一致していること（ほかのセッションを名乗らせない）
//   - strict：コマンド全体が harness-note の単純な呼び出しだけで、どれにも一致する --session がちょうど 1 つ付いていること
// 問題がなければ null、あれば理由を返す。
export function harnessNoteProblem(command, sessionId, { strict = false, cwd = null } = {}) {
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
    if (strict && sessions.length !== 1) return `harness-note には、--session ${sessionId} をちょうど 1 つ付けてください`
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

  const guards = loadGuards(ctx.repo.root)
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
    const location = locationDeny(ctx, at.abs)
    if (location) return deny(location.rule, location.message, at.subject)
    const rule = matchPathRule(guards, at.subject)
    if (rule) {
      const stop = consider(byRule(rule, at.subject))
      if (stop) return stop
    }
    const kind = at.rel === null ? null : protectedKind(at.rel, guards.protect)
    if (kind) consider(askProtected(kind, at.subject))
    if (verdict.decision === 'allow' && isAutoSession(ctx)) return ask('auto-session-after', AFTER_AUTO, at.subject)
    return verdict
  }

  if (!command.trim()) return allow
  const problem = harnessNoteProblem(command, sid, { cwd })
  if (problem) return deny(NOTE_CALL_RULE, problem, command.slice(0, 200))

  const parsed = parseBash(command)
  // コマンド置換や、読み取りに自信のない書き方があるときは、元の文字列にも当てる。
  const subjects = parsed.segments.map(skeleton)
  if (parsed.subst || parsed.uncertain) subjects.push(command)
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
    const location = locationDeny(ctx, at.abs)
    if (location) return deny(location.rule, location.message, at.subject)
    const rule = matchPathRule(guards, at.subject)
    if (rule) {
      const stop = consider(byRule(rule, at.subject))
      if (stop) return stop
    }
  }
  for (const at of targets) {
    if (at.rel === null) continue
    const kind = PROTECTED_DIRS.has(at.rel.toLowerCase()) ? 'ハーネスのディレクトリ' : protectedKind(at.rel, guards.protect)
    if (kind) consider(askProtected(kind, at.subject))
  }
  if (verdict.decision === 'allow' && !isNonChanging(command) && isAutoSession(ctx)) return ask('auto-session-after', AFTER_AUTO, command.slice(0, 200))
  return verdict
}
