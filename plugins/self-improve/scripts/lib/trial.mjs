// 試用ルール（データ領域の trial/<リポジトリID>/rules/）と、試用 Skill（~/.claude/skills/<リポジトリ名>-<名前>/）。
// 置き場所はここで固定する。呼び出し側からパスは受け取らない。
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { iso, isInside, listFiles, parseFrontmatter, personalSkillsDir, readJson, realish, writeFileAtomic, writeJson } from './core.mjs'
import { renderSkill, validateRuleText, validateSkill } from './content.mjs'

// ---- self-improve が読み込ませる行数 ----

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

// セッション開始時に self-improve が読み込ませる行数（試用ルール＋自分専用のルール）。
// 数えるのは、self-improve が足した分だけ。リポジトリの CLAUDE.md や .claude/rules/（チームのルール）は数えない
// （共有リポジトリで、チームのルールが多いだけで自動改善が止まるのを避けるため）。
export function measureAlwaysLoaded(ctx) {
  const trial = listRules(ctx).length
  const personal = listPersonalRules(ctx).length
  return { trial_rules: trial, personal_rules: personal, rule_lines: trial + personal, rule_limit: ctx.config.budget.always_loaded_rule_lines }
}

// 試用ルールをもう 1 件足せるか。足せないときは理由を返す。
export function ruleCapacity(ctx) {
  const count = listRules(ctx).length
  const max = ctx.config.auto.max_trial_rules
  if (count >= max) return { ok: false, reason: `試用ルールが上限（${max} 件）に達しています` }
  const m = measureAlwaysLoaded(ctx)
  if (m.rule_lines + 1 > m.rule_limit) {
    return { ok: false, reason: `self-improve が読み込ませるルールが行数の目安を超えます（試用ルール ${m.trial_rules} 行＋自分専用のルール ${m.personal_rules} 行、目安 ${m.rule_limit} 行）` }
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

// ---- 自分専用のルール（昇格先のひとつ）----

// 自分専用に昇格したルールは、user 側の ~/.claude/self-improve/repos/<名前>/rules.md に、1 行に 1 つ置く。
// リポジトリには何も足さない。そのリポジトリのセッション開始時に、試用ルールと一緒に読み込ませる。
// 人が直接直してもよい（書き込みには確認が出る）。
export const personalRulesFile = (ctx) => join(ctx.user.repoDir, 'rules.md')

export function listPersonalRules(ctx) {
  const text = readText(personalRulesFile(ctx))
  if (text === null) return []
  const out = []
  text.replace(/\r\n/g, '\n').split('\n').forEach((line, index) => {
    const match = /^[-*]\s+(.+?)\s*$/.exec(line)
    if (!match) return
    const ref = /（(INC-\d{4}-\d{4})）$/.exec(match[1])
    out.push({ line: index + 1, text: ref ? match[1].slice(0, ref.index).trim() : match[1], ref: ref ? ref[1] : null, raw: match[1] })
  })
  return out
}

export function addPersonalRule(ctx, { text, ref = null }) {
  const checked = validateRuleText(text)
  if (!checked.ok) return { ok: false, errors: checked.errors }
  const file = personalRulesFile(ctx)
  const current = readText(file)
  if (current !== null && listPersonalRules(ctx).some((r) => r.text === checked.text)) {
    return { ok: false, errors: ['同じ文のルールが、すでに自分専用のルールにあります'] }
  }
  const header = `# ${ctx.repo.name}：自分専用のルール\n\nself-improve が、このリポジトリのセッション開始時に読み込ませます。「- 」で始まる行が、1 行で 1 つのルールです。\n\n`
  const line = `- ${checked.text}${ref ? `（${ref}）` : ''}\n`
  const base = current === null ? header : current.endsWith('\n') ? current : `${current}\n`
  writeFileAtomic(file, `${base}${line}`)
  return { ok: true, file, line: line.trim() }
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

// このリポジトリの試用 Skill。promoted を true にすると、自分専用に昇格済みのものを返す。
export function listSkills(ctx, { promoted = false } = {}) {
  const base = personalSkillsDir()
  const out = []
  for (const name of listFiles(base)) {
    const marker = readJson(join(base, name, MARKER))
    if (!marker || marker.repo_id !== ctx.repo.id || Boolean(marker.promoted_at) !== promoted) continue
    out.push({ ...marker, dir: join(base, name), dir_name: name })
  }
  return out.sort((a, b) => String(a.added_at).localeCompare(String(b.added_at)))
}

// 試用 Skill を、自分専用に昇格する。置き場所（~/.claude/skills/）は変えず、印のファイルに昇格の日時を書く。
// 昇格したあとは試用ではないので、試用の件数にも、消える対象にも入らず、ガードも直接の編集を止めない。
export function promoteSkill(ctx, name) {
  const target = skillTarget(ctx, name)
  if (target.error) return { ok: false, errors: [target.error] }
  const marker = readJson(join(target.dir, MARKER))
  if (!marker || marker.plugin !== 'self-improve' || marker.repo_id !== ctx.repo.id || marker.promoted_at) {
    return { ok: false, errors: [`${target.dirName} は、このリポジトリの試用 Skill ではありません`] }
  }
  const next = { ...marker, promoted_at: iso(), promoted_to: 'personal' }
  writeJson(join(target.dir, MARKER), next)
  return { ok: true, skill: { ...next, dir: target.dir, dir_name: target.dirName } }
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
  if (!marker || marker.plugin !== 'self-improve' || marker.repo_id !== ctx.repo.id || marker.promoted_at) {
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
// 個人用の Skill の置き場所は、リンクのことがある（dotfiles で管理している場合など）。名前の側と実体の側の両方で見る。
export function isTrialSkillPath(absPath) {
  const target = resolve(absPath)
  for (const base of new Set([resolve(personalSkillsDir()), realish(personalSkillsDir())])) {
    if (!isInside(base, target) || target === base) continue
    const first = target.slice(base.length + 1).split(/[\\/]/)[0]
    // 自分専用に昇格した Skill は、試用ではない。人が直せる（~/.claude への書き込みなので、Claude Code の確認は出る）。
    const marker = join(base, first, MARKER)
    if (existsSync(marker) && !readJson(marker)?.promoted_at) return true
  }
  return false
}
