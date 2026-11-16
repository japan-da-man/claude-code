// init スキルから呼ぶ。user 単位の初期設定。結果は JSON で出す。
//   node init.mjs [リポジトリのパス]
// 作るのは、user の設定（~/.claude/self-improve/config.json）と、失敗票の置き場所（~/.claude/self-improve/incidents/）だけ。
// すでにあるファイルは上書きしない。リポジトリには、何も作らない。
// self-improve は init しなくても動く（設定がなければ、初期値で動く）。init は、設定のファイルを手元に置いて、
// 除外や上限を変えられるようにするためのもの。
// 次のものは、ここでは書かない（Claude が、人の確認を通して足す）：
//   - ~/.claude/settings.json の許可ルール（harness-note を確認なしで呼べるようにする）
//   - リポジトリの harness/config.json（検証コマンドを使うと答えたときだけ）
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT, claudeHome, findRepo, inactiveReason, isMain, tildePath, userDir, userRepoDir } from './lib/core.mjs'

const TEMPLATES = join(PLUGIN_ROOT, 'templates')
export const ALLOW_RULE = 'Bash(harness-note *)'

// 1.x（リポジトリごとに init していた版）の名残を調べる。何も書き換えない。
//   incidents    harness/incidents/ にある失敗票の件数（harness-note incident import で取り込める）
//   config_keys  harness/config.json にある、verify 以外の項目（読まれない。user 側へ移す）
//   allow_rule   .claude/settings.local.json に、許可ルールがあるか（user の設定に足せば、要らない）
function legacyOf(root) {
  const incidents = existsSync(join(root, 'harness', 'incidents'))
    ? readdirSync(join(root, 'harness', 'incidents')).filter((f) => /^INC-\d{4}-\d{4}\.md$/.test(f)).length
    : 0
  let configKeys = []
  let allowRule = false
  try {
    const raw = JSON.parse(readFileSync(join(root, 'harness', 'config.json'), 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) configKeys = Object.keys(raw).filter((k) => k !== 'verify')
  } catch {
    // なければ、名残もない
  }
  try {
    allowRule = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8')).permissions?.allow?.includes(ALLOW_RULE) ?? false
  } catch {
    // なければ、名残もない
  }
  return { incidents, config_keys: configKeys, allow_rule: allowRule }
}

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
        // 1.x の名残（あれば、移行を案内する）。
        legacy: legacyOf(repo.root),
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
