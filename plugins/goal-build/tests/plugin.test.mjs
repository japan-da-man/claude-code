import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './helpers.mjs'

const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')
const REPO = join(ROOT, '..', '..')

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(m, 'frontmatter がない')
  const out = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2]
  }
  return out
}

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(join(dir, f)).isFile())
}

test('plugin.json: 名前・説明（先頭にタグ）・作者が、マーケットプレイスの決まりどおり', () => {
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'))
  assert.equal(plugin.name, 'goal-build')
  assert.match(plugin.description, /^\[skills\] \[hooks\] /)
  assert.deepEqual(plugin.author, { name: 'japan-da-man' })
  assert.equal(plugin.version, undefined)
  // 他のプラグインに依存しない（一般品質のレビューは .goal-build/config の REVIEW_AGENT で任意に足す）
  assert.equal(plugin.dependencies, undefined)
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.scripts.test, 'node --test')
  assert.equal(pkg.dependencies, undefined)
})

test('marketplace.json と bundle と README に登録されている', () => {
  const market = JSON.parse(readFileSync(join(REPO, '.claude-plugin/marketplace.json'), 'utf8'))
  const entry = market.plugins.find((p) => p.name === 'goal-build')
  assert.ok(entry)
  assert.equal(entry.source, './plugins/goal-build')
  const bundle = JSON.parse(readFileSync(join(REPO, 'plugins/japan-da-man-mods/.claude-plugin/plugin.json'), 'utf8'))
  assert.ok(bundle.dependencies.includes('goal-build'))
  assert.match(bundle.description, /goal-build/)
  assert.match(market.plugins.find((p) => p.name === 'japan-da-man-mods').description, /goal-build/)
  assert.match(readFileSync(join(REPO, 'README.md'), 'utf8'), /\[goal-build\]\(plugins\/goal-build\)/)
})

test('hooks.json: 4 つのイベントを、実在するスクリプトに結び付ける', () => {
  const { hooks } = JSON.parse(read('hooks/hooks.json'))
  assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop'])
  const command = (file) => `bash "\${CLAUDE_PLUGIN_ROOT}/scripts/${file}"`
  const pre = Object.fromEntries(hooks.PreToolUse.map((h) => [h.matcher, h.hooks[0]]))
  assert.equal(pre.Bash.command, command('guard-pr.sh'))
  assert.equal(pre['Edit|Write'].command, command('guard-spec.sh'))
  // ガードが落ちたりタイムアウトしたりしたときも、操作を通さない
  for (const h of Object.values(pre)) assert.equal(h.onFailure, 'block')
  assert.equal(hooks.Stop.length, 1)
  assert.equal(hooks.Stop[0].hooks[0].command, command('run-checks.sh'))
  assert.equal(hooks.Stop[0].hooks[0].timeout, 600)
  assert.equal(hooks.SessionStart[0].matcher, 'startup|resume|clear|compact')
  assert.equal(hooks.SessionStart[0].hooks[0].command, command('session-context.sh'))
  for (const f of ['guard-pr.sh', 'guard-spec.sh', 'run-checks.sh', 'session-context.sh']) {
    accessSync(join(ROOT, 'scripts', f), constants.X_OK)
  }
})

test('skills: 人が起動するものだけ disable-model-invocation', () => {
  const expected = { setup: true, design: true, finish: true, implement: false, report: false }
  for (const [name, manual] of Object.entries(expected)) {
    const fm = frontmatter(read('skills', name, 'SKILL.md'))
    assert.equal(fm.name, name)
    assert.ok(fm.description, name)
    assert.equal(fm['disable-model-invocation'] === 'true', manual, name)
  }
  // implement と report は引数 feature を受け取る
  for (const name of ['implement', 'report']) assert.equal(frontmatter(read('skills', name, 'SKILL.md')).arguments, '[feature]')
  assert.equal(frontmatter(read('skills', 'design', 'SKILL.md')).arguments, '[feature, requirements]')
})

test('skills: 参照しているテンプレートとエージェントが実在する', () => {
  for (const file of filesUnder(join(ROOT, 'skills'))) {
    const text = read('skills', file)
    for (const [, ref] of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g)) {
      assert.ok(existsSync(join(ROOT, ref)), `${file}: ${ref}`)
    }
  }
  assert.match(read('skills', 'implement', 'SKILL.md'), /goal-build:spec-reviewer/)
  assert.match(read('skills', 'implement', 'SKILL.md'), /goal-build:report/)
})

test('spec-reviewer: 読むだけのツールしか持たない', () => {
  const fm = frontmatter(read('agents', 'spec-reviewer.md'))
  assert.equal(fm.name, 'spec-reviewer')
  assert.equal(fm.tools, 'Read, Grep, Glob')
})

test('/goal のテンプレート: 逃げ道と打ち切りを含み、PR を作らないと書いてある', () => {
  const design = read('skills', 'design', 'SKILL.md')
  assert.match(design, /\/goal 最初に Skill ツールで goal-build:implement/)
  assert.match(design, /blocked にした/)
  assert.match(design, /approved でないため開始しなかった/)
  assert.match(design, /PR の作成はしない/)
  assert.match(design, /40 ターンで打ち切る/)
})
