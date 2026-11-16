// 整合と行数を調べて警告する。コミットも作業も止めない（終了コードはいつも 0）。
//   node check.mjs [リポジトリのパス] [--json]
// 調べるのは 3 つ：
//   1. 失敗票 ID の付いたルール行が指す失敗票が実在するか
//   2. 失敗票の status と control が食い違っていないか
//   3. 常時ロードの行数（CLAUDE.md、paths なしのルール、試用ルール）が目安を超えていないか
// あわせて、設定とガードの定義が読めるかも見る（読めない harness/guards.json は、黙って無効にしない）。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMain, lineCount, makeContext } from './lib/core.mjs'
import { incidentFiles } from './lib/auto.mjs'
import { loadGuards } from './lib/guard.mjs'
import { listRules, listSkills, measureAlwaysLoaded, ruleFiles } from './lib/trial.mjs'

const STATUSES = ['open', 'trial', 'converted', 'wontfix', 'retired']
const INCIDENT_ID = /INC-\d{4}-\d{4}/g
const empty = (value) => value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function runCheck(ctx) {
  const warnings = []
  const warn = (rule, message, file = null) => warnings.push({ rule, message, file })
  const root = ctx.repo.root

  if (ctx.config.error) warn('config', `harness/config.json を読めません（${ctx.config.error}）。初期値で動いています`, 'harness/config.json')
  // 読めない harness/guards.json は、ほかの警告と分けて出す（このリポジトリのガードが、まるごと効かなくなるため）。
  for (const error of loadGuards(root).errors) {
    warn(error.startsWith('harness/guards.json を読めません') ? 'guards_unreadable' : 'guards', error, 'harness/guards.json')
  }

  // 1. ルール行の失敗票 ID
  const incidents = incidentFiles(root)
  const known = new Set(incidents.map((i) => i.id))
  const sources = [
    ...['CLAUDE.md', '.claude/CLAUDE.md'].map((file) => ({ file, text: readText(join(root, file)) })).filter((s) => s.text !== null),
    ...ruleFiles(root).map((r) => ({ file: r.file, text: r.text })),
    ...listRules(ctx).map((r) => ({ file: `試用ルール ${r.cause_key}`, text: `${r.text} ${r.ref ?? ''}` })),
  ]
  for (const source of sources) {
    source.text.split('\n').forEach((line, index) => {
      for (const id of new Set(line.match(INCIDENT_ID) ?? [])) {
        if (!known.has(id)) warn('incident_ref', `${source.file}:${index + 1} が指す失敗票 ${id} が harness/incidents/ にありません`, source.file)
      }
    })
  }

  // 2. 失敗票の status と control
  const trialRules = new Set(listRules(ctx).map((r) => r.cause_key))
  const trialSkills = new Set(listSkills(ctx).map((s) => s.dir_name))
  for (const incident of incidents) {
    const { status, control, cause_key: causeKey } = incident.data
    if (!STATUSES.includes(status)) {
      warn('incident_status', `${incident.id}：status（${status ?? 'なし'}）は ${STATUSES.join(' / ')} のどれかにしてください`, incident.file)
      continue
    }
    if (empty(causeKey)) warn('incident_status', `${incident.id}：cause_key がありません`, incident.file)
    if ((status === 'trial' || status === 'converted') && empty(control)) {
      warn('incident_control', `${incident.id}：status が ${status} なのに、control（足した制御のパス）がありません`, incident.file)
    }
    if ((status === 'open' || status === 'wontfix') && !empty(control)) {
      warn('incident_control', `${incident.id}：status が ${status} なのに、control（${control}）が書かれています`, incident.file)
    }
    if (!empty(control) && (status === 'trial' || status === 'converted')) {
      const value = String(control)
      let exists
      if (value.startsWith('trial:rules/')) exists = trialRules.has(value.slice('trial:rules/'.length))
      else if (value.startsWith('skill:')) exists = trialSkills.has(value.slice('skill:'.length))
      else exists = existsSync(join(root, value.split('#')[0]))
      if (!exists) warn('incident_control', `${incident.id}：control（${value}）が見つかりません。消したなら status を直してください`, incident.file)
      if (status === 'converted' && (value.startsWith('trial:') || value.startsWith('skill:'))) {
        warn('incident_control', `${incident.id}：status が converted なのに、control が試用（${value}）のままです`, incident.file)
      }
    }
  }

  // 3. 行数の目安
  const budget = ctx.config.budget
  const measure = measureAlwaysLoaded(ctx)
  if (measure.claude_md > budget.claude_md_lines) {
    warn('budget', `CLAUDE.md が ${measure.claude_md} 行です（目安 ${budget.claude_md_lines} 行）。詳細は paths 付きのルールか Skill へ移してください`, 'CLAUDE.md')
  }
  if (measure.rule_lines > budget.always_loaded_rule_lines) {
    warn('budget', `常時ロードのルールが ${measure.rule_lines} 行です（paths なしのルール ${measure.unscoped_rules} 行＋試用ルール ${measure.trial_rules} 行、目安 ${budget.always_loaded_rule_lines} 行）。昇格して paths を付けるか、棚卸しをしてください`)
  }
  for (const file of measure.scoped) {
    if (file.lines > budget.scoped_rule_file_lines) {
      warn('budget', `${file.file} が ${file.lines} 行です（目安 ${budget.scoped_rule_file_lines} 行）`, file.file)
    }
  }
  const claudeMd = readText(join(root, 'CLAUDE.md'))
  return { warnings, measure, incidents: incidents.length, claude_md_exists: claudeMd !== null, claude_md_lines: claudeMd === null ? 0 : lineCount(claudeMd) }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const ctx = makeContext(args.find((a) => !a.startsWith('--')) || process.cwd())
  if (!ctx) {
    process.stdout.write('harness/config.json がありません。先に /self-improve:init を実行してください。\n')
  } else {
    const result = runCheck(ctx)
    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      const m = result.measure
      process.stdout.write(`常時ロード：CLAUDE.md ${m.claude_md} 行（目安 ${m.claude_md_limit} 行）、ルール ${m.rule_lines} 行（paths なしのルール ${m.unscoped_rules} 行＋試用ルール ${m.trial_rules} 行、目安 ${m.rule_limit} 行）。失敗票 ${result.incidents} 件。\n`)
      if (!result.warnings.length) process.stdout.write('警告はありません。\n')
      for (const w of result.warnings) process.stdout.write(`警告［${w.rule}］${w.message}\n`)
    }
  }
  // 整合チェックは警告だけ。終了コードで止めない。
  process.exitCode = 0
}
