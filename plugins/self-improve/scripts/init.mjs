// init スキルから呼ぶ。適用先のリポジトリに harness/ を作る。結果は JSON で出す。
//   node init.mjs [リポジトリのパス]
// 作るのは、harness/config.json、guards.json、guards.test.json、incidents/、.gitignore への追記。
// すでにあるファイルは上書きしない。.claude/settings.local.json は書かない
// （harness-note の許可ルールは、Claude が確認を通して足す）。
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT, findRepo, isMain } from './lib/core.mjs'

const TEMPLATES = join(PLUGIN_ROOT, 'templates')
export const ALLOW_RULE = 'Bash(harness-note *)'
const IGNORE_LINE = 'harness/reports/'

export function init(start) {
  const repo = findRepo(start)
  if (!repo) return { ok: false, error: 'git リポジトリではありません。適用先は git リポジトリにしてください' }
  const created = []
  const skipped = []
  const harness = join(repo.root, 'harness')
  mkdirSync(join(harness, 'incidents'), { recursive: true })
  for (const name of ['config.json', 'guards.json', 'guards.test.json']) {
    const target = join(harness, name)
    if (existsSync(target)) {
      skipped.push(`harness/${name}`)
    } else {
      copyFileSync(join(TEMPLATES, name), target)
      created.push(`harness/${name}`)
    }
  }
  const keep = join(harness, 'incidents', '.gitkeep')
  if (!existsSync(keep)) {
    writeFileSync(keep, '')
    created.push('harness/incidents/.gitkeep')
  }
  const ignore = join(repo.root, '.gitignore')
  const current = existsSync(ignore) ? readFileSync(ignore, 'utf8') : ''
  if (current.split(/\r?\n/).some((line) => line.trim() === IGNORE_LINE || line.trim() === '/harness/reports/')) {
    skipped.push('.gitignore')
  } else {
    appendFileSync(ignore, `${current && !current.endsWith('\n') ? '\n' : ''}# self-improve: 棚卸しのレポート\n${IGNORE_LINE}\n`)
    created.push('.gitignore')
  }
  const settings = join(repo.root, '.claude', 'settings.local.json')
  let allowed = false
  try {
    allowed = JSON.parse(readFileSync(settings, 'utf8')).permissions?.allow?.includes(ALLOW_RULE) ?? false
  } catch {
    // なければ、これから足す
  }
  return {
    ok: true,
    repo: { root: repo.root, name: repo.name, id: repo.id },
    created,
    skipped,
    settings_file: '.claude/settings.local.json',
    allow_rule: ALLOW_RULE,
    allow_rule_present: allowed,
    incident_template: join(TEMPLATES, 'incident.md'),
  }
}

if (isMain(import.meta.url)) {
  const result = init(process.argv[2] || process.cwd())
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.ok ? 0 : 1
}
