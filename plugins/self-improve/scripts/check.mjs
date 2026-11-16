// 整合と行数を調べて警告する。コミットも作業も止めない（終了コードはいつも 0）。
//   node check.mjs [リポジトリのパス] [--json]
// 調べるのは 3 つ。どれも、今のリポジトリの分だけを見る（失敗票は全リポジトリの分が 1 か所にあるが、ほかのリポジトリの票は見ない）。
//   1. 試用ルールと自分専用のルールが指す失敗票が、実在するか
//   2. 失敗票の status と control が食い違っていないか
//   3. self-improve が読み込ませる行数（試用ルール＋自分専用のルール）が、目安を超えていないか
// あわせて、設定とガードの定義（4 か所）が読めるかも見る（読めないファイルを、黙って無効にしない）。
// リポジトリの CLAUDE.md や .claude/rules/ は調べない（チームのもので、self-improve が足したものではないため）。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { inactiveReason, isMain, makeContext, tildePath } from './lib/core.mjs'
import { INCIDENT_STATUSES, repoIncidents } from './lib/incidents.mjs'
import { loadGuards } from './lib/guard.mjs'
import { listPersonalRules, listRules, listSkills, measureAlwaysLoaded, personalRulesFile } from './lib/trial.mjs'

const STATUSES = INCIDENT_STATUSES
const empty = (value) => value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)

export function runCheck(ctx) {
  const warnings = []
  const warn = (rule, message, file = null) => warnings.push({ rule, message, file })
  const root = ctx.repo.root

  for (const error of ctx.config.errors) warn('config', error)
  // 読めないガードの定義は、ほかの警告と分けて出す（そのファイルのガードが、まるごと効かなくなるため）。
  const guards = loadGuards(ctx)
  for (const error of guards.errors) warn(error.endsWith('このファイルのガードは、直すまで効きません') ? 'guards_unreadable' : 'guards', error)
  for (const note of guards.notes) warn('guards', note)

  // 1. ルールの失敗票 ID（今のリポジトリの票にあるか）
  const incidents = repoIncidents(ctx)
  const known = new Set(incidents.map((i) => i.id))
  const personal = listPersonalRules(ctx)
  const personalFile = tildePath(personalRulesFile(ctx))
  for (const rule of listRules(ctx)) {
    if (rule.ref && !known.has(rule.ref)) warn('incident_ref', `試用ルール ${rule.cause_key} が指す失敗票 ${rule.ref} が、このリポジトリの失敗票にありません`)
  }
  for (const rule of personal) {
    if (rule.ref && !known.has(rule.ref)) warn('incident_ref', `${personalFile}:${rule.line} が指す失敗票 ${rule.ref} が、このリポジトリの失敗票にありません`, personalFile)
  }

  // 2. 失敗票の status と control
  const trialRules = new Set(listRules(ctx).map((r) => r.cause_key))
  const trialSkills = new Set(listSkills(ctx).map((s) => s.dir_name))
  const personalSkills = new Set(listSkills(ctx, { promoted: true }).map((s) => tildePath(s.dir)))
  for (const incident of incidents) {
    const { status, control, cause_key: causeKey } = incident.data
    if (!STATUSES.includes(status)) {
      warn('incident_status', `${incident.id}：status（${status ?? 'なし'}）は ${STATUSES.join(' / ')} のどれかにしてください`, incident.id)
      continue
    }
    if (empty(causeKey)) warn('incident_status', `${incident.id}：cause_key がありません`, incident.id)
    if ((status === 'trial' || status === 'converted') && empty(control)) {
      warn('incident_control', `${incident.id}：status が ${status} なのに、control（足した制御の場所）がありません`, incident.id)
    }
    if ((status === 'open' || status === 'wontfix') && !empty(control)) {
      warn('incident_control', `${incident.id}：status が ${status} なのに、control（${control}）が書かれています`, incident.id)
    }
    if (!empty(control) && (status === 'trial' || status === 'converted')) {
      const value = String(control)
      let exists
      if (value.startsWith('trial:rules/')) exists = trialRules.has(value.slice('trial:rules/'.length))
      else if (value.startsWith('skill:')) exists = trialSkills.has(value.slice('skill:'.length))
      // 自分専用に昇格したもの：ルールは rules.md、Skill は ~/.claude/skills/ の下。
      else if (value.startsWith('personal:')) exists = value.slice('personal:'.length) === personalFile ? personal.length > 0 : personalSkills.has(value.slice('personal:'.length))
      else exists = existsSync(join(root, value.split('#')[0]))
      if (!exists) warn('incident_control', `${incident.id}：control（${value}）が見つかりません。消したなら status を直してください`, incident.id)
      if (status === 'converted' && (value.startsWith('trial:') || value.startsWith('skill:'))) {
        warn('incident_control', `${incident.id}：status が converted なのに、control が試用（${value}）のままです`, incident.id)
      }
    }
  }

  // 3. 行数の目安（self-improve が足した分だけ）
  const measure = measureAlwaysLoaded(ctx)
  if (measure.rule_lines > measure.rule_limit) {
    warn('budget', `self-improve が読み込ませるルールが ${measure.rule_lines} 行です（試用ルール ${measure.trial_rules} 行＋自分専用のルール ${measure.personal_rules} 行、目安 ${measure.rule_limit} 行）。/self-improve:review で、チームへ昇格するか、減らしてください`)
  }
  return { warnings, measure, incidents: incidents.length }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const start = args.find((a) => !a.startsWith('--')) || process.cwd()
  const ctx = makeContext(start)
  if (!ctx) {
    process.stdout.write(`${inactiveReason(start) ?? 'self-improve は、ここでは動いていません'}。\n`)
  } else {
    const result = runCheck(ctx)
    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      const m = result.measure
      process.stdout.write(`self-improve が読み込ませるルール：${m.rule_lines} 行（試用ルール ${m.trial_rules} 行＋自分専用のルール ${m.personal_rules} 行、目安 ${m.rule_limit} 行）。このリポジトリの失敗票 ${result.incidents} 件。\n`)
      if (!result.warnings.length) process.stdout.write('警告はありません。\n')
      for (const w of result.warnings) process.stdout.write(`警告［${w.rule}］${w.message}\n`)
    }
  }
}
