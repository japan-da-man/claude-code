// init スキルから呼ぶ。user 単位の初期設定。結果は JSON で出す。
//   node init.mjs [リポジトリのパス]
// 作るのは、user の設定（~/.claude/self-improve/config.json）と、失敗票の置き場所（~/.claude/self-improve/incidents/）だけ。
// すでにあるファイルは上書きしない。リポジトリには、何も作らない。
// self-improve は init しなくても動く（設定がなければ、初期値で動く）。init は、設定のファイルを手元に置いて、
// 除外や上限を変えられるようにするためのもの。
// 次のものは、ここでは書かない（Claude が、人の確認を通して足す）：
//   - ~/.claude/settings.json の許可ルール（harness-note を確認なしで呼べるようにする）
//   - リポジトリの harness/config.json（検証コマンドを使うと答えたときだけ）
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT, claudeHome, findRepo, inactiveReason, isMain, tildePath, userDir, userRepoDir } from './lib/core.mjs'

const TEMPLATES = join(PLUGIN_ROOT, 'templates')
export const ALLOW_RULE = 'Bash(harness-note *)'

export function init(start) {
  const created = []
  const skipped = []
  const dir = userDir()
  mkdirSync(join(dir, 'incidents'), { recursive: true })
  const config = join(dir, 'config.json')
  if (existsSync(config)) {
    skipped.push(tildePath(config))
  } else {
    copyFileSync(join(TEMPLATES, 'config.json'), config)
    created.push(tildePath(config))
  }
  const settings = join(claudeHome(), 'settings.json')
  let allowed = false
  try {
    allowed = JSON.parse(readFileSync(settings, 'utf8')).permissions?.allow?.includes(ALLOW_RULE) ?? false
  } catch {
    // なければ、これから足す
  }
  // いまいるリポジトリ（あれば）。検証コマンドを使うかどうかを尋ねるのに使う。
  const repo = findRepo(start)
  return {
    ok: true,
    user_dir: tildePath(dir),
    created,
    skipped,
    settings_file: tildePath(settings),
    allow_rule: ALLOW_RULE,
    allow_rule_present: allowed,
    repo: repo
      ? {
        root: repo.root,
        name: repo.name,
        id: repo.id,
        // このリポジトリで self-improve が動かない理由（除外してある、など）。動くなら null。
        inactive: inactiveReason(start),
        verify_config: 'harness/config.json',
        verify_config_exists: existsSync(join(repo.root, 'harness', 'config.json')),
        verify_template: join(TEMPLATES, 'repo-config.json'),
        override_dir: tildePath(userRepoDir(repo)),
      }
      : null,
    templates: { guards: join(TEMPLATES, 'guards.json'), guards_test: join(TEMPLATES, 'guards.test.json'), incident: join(TEMPLATES, 'incident.md') },
  }
}

if (isMain(import.meta.url)) {
  const result = init(process.argv[2] || process.cwd())
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.ok ? 0 : 1
}
