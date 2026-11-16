// 試用ルール（データ領域の trial/<リポジトリID>/rules/）と、試用 Skill（~/.claude/skills/<リポジトリ名>-<名前>/）。
// 置き場所はここで固定する。呼び出し側からパスは受け取らない。
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { iso, isInside, lineCount, listFiles, parseFrontmatter, personalSkillsDir, readJson, writeFileAtomic, writeJson } from './core.mjs'
import { renderSkill, validateRuleText, validateSkill } from './content.mjs'

// ---- 常時ロードの行数 ----

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function ruleFiles(root) {
  const base = join(root, '.claude', 'rules')
  let names = []
  try {
    names = readdirSync(base, { recursive: true }).map(String)
  } catch {
    return []
  }
  const out = []
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    const text = readText(join(base, name))
    if (text === null) continue
    const { data } = parseFrontmatter(text)
    const paths = data?.paths
    const scoped = Array.isArray(paths) ? paths.length > 0 : Boolean(paths)
    out.push({ file: `.claude/rules/${name.split('\\').join('/')}`, text, lines: lineCount(text), scoped })
  }
  return out
}

// 常時ロードの行数。試用ルールは毎回読み込まれるので、常時ロードとして数える。
// 自動改善が追加をやめるかどうかは、rule_lines（paths なしのルール＋試用ルール）と rule_limit で決める。
// CLAUDE.md の行数は、警告にだけ使う。
export function measureAlwaysLoaded(ctx) {
  const budget = ctx.config.budget
  const claudeMd = [join(ctx.repo.root, 'CLAUDE.md'), join(ctx.repo.root, '.claude', 'CLAUDE.md')]
    .map(readText).filter((t) => t !== null).reduce((sum, t) => sum + lineCount(t), 0)
  const rules = ruleFiles(ctx.repo.root)
  const unscoped = rules.filter((r) => !r.scoped).reduce((sum, r) => sum + r.lines, 0)
  const trial = listRules(ctx).length
  return {
    claude_md: claudeMd,
    claude_md_limit: budget.claude_md_lines,
    unscoped_rules: unscoped,
    trial_rules: trial,
    rule_lines: unscoped + trial,
    rule_limit: budget.always_loaded_rule_lines,
    total: claudeMd + unscoped + trial,
    scoped: rules.filter((r) => r.scoped).map((r) => ({ file: r.file, lines: r.lines })),
  }
}

// 試用ルールをもう 1 件足せるか。足せないときは理由を返す。
export function ruleCapacity(ctx) {
  const count = listRules(ctx).length
  const max = ctx.config.auto.max_trial_rules
  if (count >= max) return { ok: false, reason: `試用ルールが上限（${max} 件）に達しています` }
  const m = measureAlwaysLoaded(ctx)
  if (m.rule_lines + 1 > m.rule_limit) {
    return { ok: false, reason: `常時ロードのルールが行数の目安を超えます（paths なしのルール ${m.unscoped_rules} 行＋試用ルール ${m.trial_rules} 行、目安 ${m.rule_limit} 行）` }
  }
  return { ok: true, reason: null }
}

export function skillCapacity(ctx) {
  const max = ctx.config.auto.max_trial_skills
  if (listSkills(ctx).length >= max) return { ok: false, reason: `試用 Skill が上限（${max} 件）に達しています` }
  return { ok: true, reason: null }
}

// ---- 試用ルール ----

const ruleFile = (ctx, key) => join(ctx.dirs.rules, `${key}.json`)

export function listRules(ctx) {
  const out = []
  for (const file of listFiles(ctx.dirs.rules, (f) => f.endsWith('.json'))) {
    const rule = readJson(join(ctx.dirs.rules, file))
    if (rule && rule.cause_key && typeof rule.text === 'string') out.push(rule)
  }
  return out.sort((a, b) => String(a.added_at).localeCompare(String(b.added_at)))
}

export function getRule(ctx, key) {
  return readJson(ruleFile(ctx, key))
}

// Claude のコンテキストに読み込ませる形。「命令形 1 行＋失敗票 ID」。
export function renderRule(rule) {
  return `- ${rule.text}（${rule.ref || `下書き:${rule.cause_key}`}）`
}

export function addRule(ctx, { key, text, ref = null, by = 'human' }) {
  const checked = validateRuleText(text)
  if (!checked.ok) return { ok: false, errors: checked.errors }
  if (existsSync(ruleFile(ctx, key))) {
    return { ok: false, errors: [`原因キー ${key} の試用ルールは、すでにあります。文言を直すなら trial edit を使ってください`] }
  }
  const rule = { cause_key: key, text: checked.text, ref, by, added_at: iso(), edited_at: null, edits: 0, history: [] }
  mkdirSync(ctx.dirs.rules, { recursive: true })
  writeJson(ruleFile(ctx, key), rule)
  return { ok: true, rule }
}

export function editRule(ctx, { key, text = null, ref = undefined, by = 'human' }) {
  const current = getRule(ctx, key)
  if (!current) return { ok: false, errors: [`原因キー ${key} の試用ルールがありません`] }
  const next = { ...current }
  if (text !== null) {
    const checked = validateRuleText(text)
    if (!checked.ok) return { ok: false, errors: checked.errors }
    next.history = [...(current.history ?? []), { at: iso(), text: current.text, by }].slice(-10)
    next.text = checked.text
    next.edited_at = iso()
    next.edits = (current.edits ?? 0) + 1
  }
  if (ref !== undefined) next.ref = ref
  writeJson(ruleFile(ctx, key), next)
  return { ok: true, rule: next, previous: current }
}

export function removeRule(ctx, key) {
  const current = getRule(ctx, key)
  if (!current) return { ok: false, errors: [`原因キー ${key} の試用ルールがありません`] }
  rmSync(ruleFile(ctx, key), { force: true })
  return { ok: true, rule: current }
}

// ---- 試用 Skill ----

const MARKER = '.self-improve.json'

export function skillDirName(ctx, name) {
  return `${ctx.repo.name}-${name}`
}

// 書き込み先を決める。名前から作ったパスが、個人用の Skill の置き場所の直下に収まることを確かめる。
// .. や区切り文字、シンボリックリンク経由で外へ出るものは拒否する。
function skillTarget(ctx, name) {
  const base = personalSkillsDir()
  const dirName = skillDirName(ctx, name)
  if (dirName.includes('/') || dirName.includes('\\') || dirName.includes('..') || dirName.length > 64) {
    return { error: 'Skill の名前が長すぎるか、使えない文字を含んでいます' }
  }
  const dir = resolve(base, dirName)
  if (resolve(dir, '..') !== resolve(base)) return { error: 'Skill の置き場所が、個人用の Skill の置き場所の外になります' }
  for (const path of [dir, join(dir, 'SKILL.md'), join(dir, MARKER)]) {
    let stat = null
    try {
      stat = lstatSync(path)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) return { error: `シンボリックリンクには書き込みません：${path}` }
  }
  if (existsSync(base)) {
    const realBase = realpathSync(base)
    const realDir = existsSync(dir) ? realpathSync(dir) : join(realBase, dirName)
    if (!isInside(realBase, realDir) || realDir === realBase) return { error: 'Skill の置き場所が、個人用の Skill の置き場所の外になります' }
  }
  return { base, dir, dirName }
}

export function listSkills(ctx) {
  const base = personalSkillsDir()
  const out = []
  for (const name of listFiles(base)) {
    const marker = readJson(join(base, name, MARKER))
    if (!marker || marker.repo_id !== ctx.repo.id) continue
    out.push({ ...marker, dir: join(base, name), dir_name: name })
  }
  return out.sort((a, b) => String(a.added_at).localeCompare(String(b.added_at)))
}

export function readSkill(skill) {
  try {
    return readFileSync(join(skill.dir, 'SKILL.md'), 'utf8')
  } catch {
    return null
  }
}

// SKILL.md の全文を受け取ったときは、設定欄を取り出して検査に回す。
export function parseSkillMarkdown(text) {
  const { data, keys, body } = parseFrontmatter(String(text).replace(/\r\n/g, '\n'))
  if (!data) return { name: null, description: null, body: text, frontmatterKeys: [] }
  return { name: data.name ?? null, description: data.description ?? null, body, frontmatterKeys: keys }
}

export function addSkill(ctx, { key, name, description, body, frontmatterKeys = [], by = 'auto' }) {
  const checked = validateSkill({ name, description, body, frontmatterKeys, repoName: ctx.repo.name })
  if (!checked.ok) return { ok: false, errors: checked.errors }
  const target = skillTarget(ctx, name)
  if (target.error) return { ok: false, errors: [target.error] }
  if (existsSync(target.dir)) {
    return { ok: false, errors: [`${target.dirName} という Skill は、すでにあります。別の名前にしてください`] }
  }
  mkdirSync(target.dir, { recursive: true })
  const marker = { plugin: 'self-improve', repo_id: ctx.repo.id, repo_name: ctx.repo.name, cause_key: key, name, by, added_at: iso() }
  writeFileAtomic(join(target.dir, 'SKILL.md'), renderSkill({ dirName: target.dirName, description: checked.description, body: checked.body }))
  writeJson(join(target.dir, MARKER), marker)
  return { ok: true, skill: { ...marker, dir: target.dir, dir_name: target.dirName } }
}

// 消せるのは、このプラグインがこのリポジトリのために置いた Skill だけ（印のファイルで見分ける）。
export function removeSkill(ctx, name) {
  const target = skillTarget(ctx, name)
  if (target.error) return { ok: false, errors: [target.error] }
  const marker = readJson(join(target.dir, MARKER))
  if (!marker || marker.plugin !== 'self-improve' || marker.repo_id !== ctx.repo.id) {
    return { ok: false, errors: [`${target.dirName} は、このリポジトリの試用 Skill ではありません`] }
  }
  const extra = listFiles(target.dir).filter((f) => f !== 'SKILL.md' && f !== MARKER)
  if (extra.length) {
    return { ok: false, errors: [`${target.dirName} に、置いた覚えのないファイルがあります（${extra.join('、')}）。人が確かめてから消してください`] }
  }
  rmSync(target.dir, { recursive: true, force: true })
  return { ok: true, skill: { ...marker, dir: target.dir, dir_name: target.dirName } }
}

// あるパスが、試用 Skill の中かどうか（ガードが直接の書き込みを止めるのに使う）。
export function isTrialSkillPath(absPath) {
  const base = personalSkillsDir()
  if (!isInside(base, absPath) || resolve(absPath) === resolve(base)) return false
  const first = resolve(absPath).slice(resolve(base).length + 1).split(/[\\/]/)[0]
  return existsSync(join(base, first, MARKER))
}
