// ガードの判定。禁止操作は拒否（deny）、ハーネスのファイルへの書き込みは確認（ask）。
// 自動改善のセッションでは、書き込みをすべて拒否する（確認は出さない。通すのは harness-note と読むだけのコマンド）。
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { PLUGIN_ROOT, isInside, isLocked, posix, readJson, realish } from './core.mjs'
import { isNonChanging, parseBash, skeleton, writeTargets } from './bash.mjs'
import { isTrialSkillPath } from './trial.mjs'

export const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
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

// 共通リスト（プラグインの初期値）と、リポジトリ固有の harness/guards.json を合わせる。
// ルールは 2 種類：pattern（Bash のコマンドに当てる）と path（書き込み先のパスに当てる）。
export function loadGuards(repoRoot) {
  const errors = []
  const defaults = readJson(DEFAULT_GUARDS, { rules: [] })
  const repo = readJson(join(repoRoot, 'harness', 'guards.json'), {}) || {}
  const off = new Set(Array.isArray(repo.disable_defaults) ? repo.disable_defaults : [])
  const rules = []
  const sources = [
    ...(defaults.rules ?? []).filter((r) => !off.has(r.id)).map((r) => ({ ...r, source: 'default' })),
    ...(Array.isArray(repo.rules) ? repo.rules : []).map((r) => ({ ...r, source: 'repo' })),
  ]
  for (const rule of sources) {
    const where = `${rule.source === 'default' ? 'guards.default.json' : 'harness/guards.json'} の ${rule.id ?? '（id なし）'}`
    if (!rule.id || !rule.message) {
      errors.push(`${where}：id と message（直し方を 1 行）が必要です`)
      continue
    }
    const pattern = compile(rule.pattern, rule.flags, errors, where)
    const path = compile(rule.path, rule.flags, errors, where)
    if (!pattern && !path) {
      if (!rule.pattern && !rule.path) errors.push(`${where}：pattern か path が必要です`)
      continue
    }
    rules.push({ ...rule, pattern, path, except: compile(rule.except, rule.flags, errors, where) })
  }
  const protect = (Array.isArray(repo.protect) ? repo.protect : []).map((p, i) => compile(p, '', errors, `harness/guards.json の protect[${i}]`)).filter(Boolean)
  return { rules, protect, errors }
}

// ---- 確認を挟むパス ----

const HARNESS_FILES = new Set(['harness/config.json', 'harness/guards.json', 'harness/guards.test.json'])
const PROTECTED_DIRS = new Set(['harness', '.claude', '.claude/rules', '.claude/skills'])
const LINTER_CONFIG = /(^|\/)(\.eslintrc(\.[a-z]+)?|eslint\.config\.[a-z]+|biome\.jsonc?|\.oxlintrc\.json|\.?ruff\.toml|\.flake8|\.pylintrc|\.rubocop\.yml|\.golangci\.ya?ml|\.swiftlint\.yml|\.stylelintrc(\.[a-z]+)?|stylelint\.config\.[a-z]+|\.?clippy\.toml|detekt\.ya?ml)$/

export function protectedKind(rel, protect = []) {
  if (HARNESS_FILES.has(rel)) return 'ハーネスの設定'
  if (rel.startsWith('.claude/rules/')) return '昇格済みのルール'
  if (rel.startsWith('.claude/skills/')) return 'Skill'
  if (/(^|\/)CLAUDE(\.local)?\.md$/.test(rel)) return 'CLAUDE.md'
  if (LINTER_CONFIG.test(rel)) return 'リンター設定'
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

const LOCKED_MESSAGE = '自動改善のセッションでは、ファイルへの書き込みはすべて拒否します。書き込みは harness-note だけを使い、読むだけなら Read / Grep / Glob を使ってください。リポジトリのファイルを変える案は、harness-note pending add --proposal-kind で報告に載せてください。'

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

const deny = (rule, message, target) => ({ decision: 'deny', rule, message, target })
const ask = (kind, subject) => ({
  decision: 'ask',
  rule: 'harness-files',
  target: subject,
  message: `${kind}（${subject}）への書き込みです。ハーネスの変更は、差分を確かめてから承認してください（self-improve）。`,
})

function matchPathRules(guards, subject) {
  return guards.rules.find((r) => r.path && r.path.test(subject) && !(r.except && r.except.test(subject))) ?? null
}

// PreToolUse の入力を受けて、allow / deny / ask を返す。
export function evaluate(ctx, input) {
  const tool = input.tool_name
  const ti = input.tool_input ?? {}
  const cwd = input.cwd || ctx.repo.root
  const guards = loadGuards(ctx.repo.root)
  const locked = isLocked(ctx)

  if (FILE_TOOLS.has(tool)) {
    const raw = ti.file_path ?? ti.notebook_path
    if (typeof raw !== 'string' || !raw) return { decision: 'allow' }
    const at = locate(ctx, raw, cwd)
    const rule = matchPathRules(guards, at.subject)
    if (rule) return deny(rule.id, rule.message, at.subject)
    const location = locationDeny(ctx, at.abs)
    if (location) return deny(location.rule, location.message, at.subject)
    if (locked) return deny('auto-session', LOCKED_MESSAGE, at.subject)
    const kind = at.rel === null ? null : protectedKind(at.rel, guards.protect)
    return kind ? ask(kind, at.subject) : { decision: 'allow' }
  }

  if (tool === 'Bash') {
    const command = String(ti.command ?? '')
    if (!command.trim()) return { decision: 'allow' }
    const parsed = parseBash(command)
    // コマンド置換があると区切りを追い切れないので、そのときは元の文字列にも当てる。
    const subjects = parsed.segments.map(skeleton)
    if (parsed.subst || parsed.heredocUnsafe) subjects.push(command)
    for (const rule of guards.rules) {
      if (!rule.pattern) continue
      const hit = subjects.find((s) => rule.pattern.test(s) && !(rule.except && rule.except.test(s)))
      if (hit) return deny(rule.id, rule.message, hit.slice(0, 200))
    }
    const targets = []
    let here = cwd
    for (const entry of writeTargets(command)) {
      if (entry.cd) here = locate(ctx, entry.cd, here).abs
      targets.push(...entry.tokens.map((token) => locate(ctx, token, here)))
    }
    for (const at of targets) {
      const rule = matchPathRules(guards, at.subject)
      if (rule) return deny(rule.id, rule.message, at.subject)
      const location = locationDeny(ctx, at.abs)
      if (location) return deny(location.rule, location.message, at.subject)
    }
    if (locked && !isNonChanging(command)) return deny('auto-session', LOCKED_MESSAGE, command.slice(0, 200))
    for (const at of targets) {
      if (at.rel === null) continue
      const kind = PROTECTED_DIRS.has(at.rel) ? 'ハーネスのディレクトリ' : protectedKind(at.rel, guards.protect)
      if (kind) return ask(kind, at.subject)
    }
  }
  return { decision: 'allow' }
}
