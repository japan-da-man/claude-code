import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadActors, loadFeatures, parseActors, parseFrontmatter, parseSections, renderIndex, runCheck } from '../scripts/check.mjs'

const CHECK = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url))

const ACTORS = `# Actor

| ID | 名前 | 説明 |
| :- | :- | :- |
| user | 利用者 | 自分のタスクを管理する人 |
| system | システム | 時刻になると通知を出す |
`

const feature = ({ id, name = 'タスクを追加する', status = '提供中', actors = '[user]', related = '', extra = '', body } = {}) => `---
id: ${id}
name: ${name}
status: ${status}
actors: ${actors}
${related}${extra}---

${
  body ??
  `## 概要

タイトルを入れて、新しいタスクを登録する。

## 利用シーン

- 移動中にやることを思いついた → 忘れる前に残したい
`
}`

function makeRepo(files = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'fm-check-'))
  mkdirSync(join(repo, 'docs', 'features'), { recursive: true })
  const all = { 'actors.md': ACTORS, ...files }
  for (const [name, text] of Object.entries(all)) if (text !== null) writeFileSync(join(repo, 'docs', 'features', name), text)
  return repo
}

const writeIndex = (repo) => writeFileSync(join(repo, 'docs', 'features', 'README.md'), renderIndex(loadFeatures(repo), loadActors(repo)))
const rules = (list) => list.map((e) => `${e.file.split('/').pop()}:${e.rule}`)
// actors.md の「使っている機能がない」警告を除いた、機能ファイルの警告
const featureWarnings = (r) => r.warnings.filter((w) => !w.file.endsWith('/actors.md'))

test('parseFrontmatter reads scalars, inline lists and lists of id and note', () => {
  const { data, lineOf } = parseFrontmatter(`---
id: reminder
name: "期日の前に知らせる"
draft: true
actors: [user, system]
related:
  - id: task-create
    note: 追加するときに、通知も決める
  - id: task-complete
---
本文`)
  assert.deepEqual(data, {
    id: 'reminder',
    name: '期日の前に知らせる',
    draft: true,
    actors: ['user', 'system'],
    related: [{ id: 'task-create', note: '追加するときに、通知も決める' }, { id: 'task-complete' }],
  })
  assert.equal(lineOf.related, 6)
  assert.equal(data.related[1].line, 9)
})

test('parseFrontmatter reads a block list of plain values', () => {
  const { data } = parseFrontmatter('---\nactors:\n  - user\n  - system\n---\n')
  assert.deepEqual(data.actors, ['user', 'system'])
})

test('parseFrontmatter reports a missing or unreadable frontmatter with its line', () => {
  assert.equal(parseFrontmatter('# タイトル\n').error.line, 1)
  assert.match(parseFrontmatter('---\nid: a\n').error.message, /終わり/)
  assert.deepEqual(parseFrontmatter('---\nid: a\n  stray\n---\n').error.line, 3)
})

test('parseSections splits on ## headings and ignores code blocks', () => {
  const sections = parseSections(['## 概要', 'a', '```', '## not a heading', '```', '### 小見出し', '## 前提', 'b'], 10)
  assert.deepEqual(
    sections.map((s) => [s.title, s.line]),
    [
      ['概要', 10],
      ['前提', 16],
    ],
  )
})

test('parseActors reads the rows of the ID table only', () => {
  const actors = parseActors(ACTORS + '\n| 別の表 | x |\n| :- | :- |\n| a | b |\n')
  assert.deepEqual(
    actors.map((a) => [a.id, a.name, a.line]),
    [
      ['user', '利用者', 5],
      ['system', 'システム', 6],
    ],
  )
})

test('a well-formed master has no errors, and the generated index makes it up to date', () => {
  const repo = makeRepo({
    'task-create.md': feature({ id: 'task-create', related: 'related:\n  - id: reminder\n    note: 期日のあるタスクは、通知も決める\n' }),
    'reminder.md': feature({ id: 'reminder', name: '期日の前に知らせる', actors: '[user, system]', extra: 'draft: true\n' }),
  })
  let r = runCheck(repo)
  assert.equal(r.ok, true)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.warnings, [])
  assert.deepEqual(r.drafts, [{ id: 'reminder', file: 'docs/features/reminder.md' }])
  assert.equal(r.stale.length, 1)
  writeIndex(repo)
  r = runCheck(repo)
  assert.deepEqual(r.stale, [])
  const index = readFileSync(join(repo, 'docs', 'features', 'README.md'), 'utf8')
  assert.match(index, /\| \[期日の前に知らせる\]\(reminder\.md\) \| 提供中（下書き） \| 利用者、システム \| タイトルを入れて、新しいタスクを登録する。 \| {2}\|/)
  assert.match(index, /\| \[タスクを追加する\]\(task-create\.md\) \| 提供中 \| 利用者 \| .+ \| \[reminder\]\(reminder\.md\) \|/)
  assert.match(index, /\| user \| 利用者 \| 自分のタスクを管理する人 \| 2 \|/)
})

test('the index goes stale when a feature file changes', () => {
  const repo = makeRepo({ 'task-create.md': feature({ id: 'task-create' }) })
  writeIndex(repo)
  writeFileSync(join(repo, 'docs', 'features', 'task-create.md'), feature({ id: 'task-create', name: 'タスクを登録する' }))
  assert.equal(runCheck(repo).stale.length, 1)
})

test('id, name, status, actors and draft are checked', () => {
  const repo = makeRepo({
    'a.md': feature({ id: 'b' }),
    'Bad_Name.md': feature({ id: 'Bad_Name' }),
    'c.md': feature({ id: 'c', name: '', status: '完成', actors: '[]', extra: 'draft: yes\n' }),
    'd.md': feature({ id: 'd', actors: '[guest]' }),
  })
  assert.deepEqual(rules(runCheck(repo).errors).sort(), ['Bad_Name.md:id', 'a.md:id', 'c.md:actors', 'c.md:draft', 'c.md:name', 'c.md:status', 'd.md:actors'])
})

test('related must point to other existing features, and a missing note is a warning', () => {
  const repo = makeRepo({
    'a.md': feature({ id: 'a', related: 'related:\n  - id: a\n    note: x\n  - id: nowhere\n    note: x\n  - id: b\n  - plain\n' }),
    'b.md': feature({ id: 'b', related: 'related: [a]\n' }),
  })
  const r = runCheck(repo)
  assert.deepEqual(rules(r.errors), ['a.md:related', 'a.md:related', 'a.md:related', 'b.md:related'])
  assert.match(r.errors[1].message, /nowhere/)
  assert.deepEqual(rules(featureWarnings(r)), ['a.md:related'])
  assert.match(featureWarnings(r)[0].message, /note/)
})

test('概要 and 利用シーン are required, and scenes should read 状況 → したいこと', () => {
  const repo = makeRepo({
    'a.md': feature({ id: 'a', body: '## 概要\n\n<!-- まだ書いていない -->\n\n## 利用シーン\n\n- 思いついたとき\n- 移動中 → 残したい\n\n## メモ\n\nx\n' }),
    'b.md': feature({ id: 'b', body: '## 概要\n\n登録する。\n\n## 利用シーン\n\n思いついたときに使う。\n' }),
    'c.md': feature({ id: 'c', body: '## 概要\n\n登録する。\n' }),
  })
  const r = runCheck(repo)
  assert.deepEqual(rules(r.errors), ['a.md:section', 'c.md:section'])
  assert.deepEqual(rules(featureWarnings(r)), ['a.md:section', 'a.md:scene', 'b.md:scene'])
  assert.equal(featureWarnings(r)[1].line, 14)
})

test('actors.md must exist and have valid rows; unused actors and unknown keys are warnings', () => {
  let repo = makeRepo({ 'actors.md': null })
  assert.deepEqual(rules(runCheck(repo).errors), ['actors.md:actors'])
  repo = makeRepo({ 'actors.md': '| ID | 名前 | 説明 |\n| :- | :- | :- |\n| User | 利用者 | |\n| user | | |\n| user | 利用者 | |\n' })
  assert.deepEqual(rules(runCheck(repo).errors), ['actors.md:actors', 'actors.md:actors', 'actors.md:actors'])
  repo = makeRepo({ 'a.md': feature({ id: 'a', extra: 'owner: me\n' }) })
  assert.deepEqual(rules(runCheck(repo).warnings), ['a.md:key', 'actors.md:actors'])
})

test('a feature file with broken frontmatter is an error, and the index is not compared', () => {
  const repo = makeRepo({ 'a.md': '# a\n' })
  const r = runCheck(repo)
  assert.deepEqual(rules(r.errors), ['a.md:frontmatter'])
  assert.deepEqual(r.stale, [])
})

test('check.mjs exits 1 on errors, 0 otherwise, and 2 without docs/features', () => {
  const ok = makeRepo({ 'a.md': feature({ id: 'a' }) })
  let p = spawnSync('node', [CHECK, '--repo', ok], { encoding: 'utf8' })
  assert.equal(p.status, 0)
  assert.match(p.stdout, /エラーなし（機能 1・Actor 2）/)
  const bad = makeRepo({ 'a.md': feature({ id: 'b' }) })
  p = spawnSync('node', [CHECK, '--repo', bad, '--json'], { encoding: 'utf8' })
  assert.equal(p.status, 1)
  assert.equal(JSON.parse(p.stdout).ok, false)
  p = spawnSync('node', [CHECK, '--repo', mkdtempSync(join(tmpdir(), 'fm-none-'))], { encoding: 'utf8' })
  assert.equal(p.status, 2)
})
