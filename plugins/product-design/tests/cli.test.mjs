import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { componentTemplates, install, stage, status, trace } from '../scripts/cli.mjs'
import { tempRepo } from './helpers.mjs'

const CLI = fileURLToPath(new URL('../scripts/cli.mjs', import.meta.url))

const fresh = (base) => {
  const repo = tempRepo({ 'README.md': '# app\n' })
  install(repo, { base })
  return repo
}

for (const base of ['hig', 'shadcn']) {
  test(`the ${base} templates pass the copied check with --strict and leave no warnings`, () => {
    const repo = fresh(base)
    const r = spawnSync(process.execPath, [join(repo, 'design-system', 'check.mjs'), '--strict', '--json'], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const out = JSON.parse(r.stdout)
    assert.deepEqual(out.ds_errors, [])
    assert.deepEqual(out.warnings, [])
    assert.deepEqual(out.candidates, [])
  })
}

test('every product principle in the template has a priority line, a scene and what it gives up', () => {
  const text = readFileSync(fileURLToPath(new URL('../templates/product/principles.md', import.meta.url)), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  const sections = text.split(/^(?=### P\d+ )/m).slice(1)
  assert.ok(sections.length >= 3 && sections.length <= 5, `${sections.length} principles`)
  for (const s of sections) {
    const id = s.slice(4, s.indexOf(' ', 4))
    assert.match(s, /^\*\*.+を優先する。\*\*$/m, id)
    assert.match(s, /^- 場面: \S/m, id)
    assert.match(s, /^- 捨てるもの: \S/m, id)
  }
})

test('install writes a v2 config with every stage pending and places the templates', () => {
  const repo = fresh('hig')
  const config = JSON.parse(readFileSync(join(repo, 'design-system', 'design-system.json'), 'utf8'))
  assert.equal(config.version, 2)
  assert.equal(config.base, 'hig')
  assert.deepEqual(Object.values(config.stages), ['pending', 'pending', 'pending', 'pending', 'pending'])
  for (const f of ['docs/product/principles.md', 'docs/design-candidates/README.md', 'design-system/tokens.json', 'design-system/CHANGELOG.md', 'design-system/check.mjs']) assert.ok(existsSync(join(repo, f)), f)
  assert.equal(readdirSync(join(repo, 'design-system', 'components')).length, 18)
  assert.match(readFileSync(join(repo, 'design-system/components/button.md'), 'utf8'), /filled/)
})

test('each base gets its own button spec', () => {
  assert.match(componentTemplates('shadcn').get('button'), /button\.shadcn\.md$/)
  assert.match(componentTemplates('hig').get('button'), /button\.hig\.md$/)
  assert.equal(componentTemplates('hig').size, 18)
})

test('install again keeps edited files and the config, and only refreshes check.mjs', () => {
  const repo = fresh('hig')
  writeFileSync(join(repo, 'design-system', 'copy.md'), '# 書き直した\n')
  writeFileSync(join(repo, 'design-system', 'check.mjs'), '// 古い\n')
  const r = install(repo, { base: 'shadcn' })
  assert.equal(r.config, 'kept')
  assert.equal(r.base, 'hig')
  assert.deepEqual(r.copied, [])
  assert.equal(readFileSync(join(repo, 'design-system', 'copy.md'), 'utf8'), '# 書き直した\n')
  assert.notEqual(readFileSync(join(repo, 'design-system', 'check.mjs'), 'utf8'), '// 古い\n')
})

test('install needs a base for a new config and refuses a v1 one', () => {
  assert.throws(() => install(tempRepo({ 'a.txt': '' })), /--base hig か --base shadcn/)
  const v1 = tempRepo({ 'design-system/design-system.json': { version: 1, platform: 'ios' } })
  assert.throws(() => install(v1, { base: 'hig' }), /v1 です/)
})

test('approving a stage puts the approved stages below it back to pending', () => {
  const repo = fresh('hig')
  for (const s of ['product', 'design', 'foundations', 'components']) stage(repo, s, 'approved')
  const r = stage(repo, 'design', 'approved')
  assert.deepEqual(r.reset, ['foundations', 'components'])
  assert.deepEqual(r.stages, { product: 'approved', design: 'approved', foundations: 'pending', components: 'pending', outputs: 'pending' })
  assert.throws(() => stage(repo, 'html', 'approved'), /段は/)
})

test('status shows the next stage and a stale check.mjs', () => {
  const repo = fresh('hig')
  stage(repo, 'product', 'approved')
  assert.equal(status(repo).next, 'design')
  assert.deepEqual(status(repo).stale, [])
  writeFileSync(join(repo, 'design-system', 'check.mjs'), '// 古い\n')
  assert.match(status(repo).stale[0], /check\.mjs がプラグインの版と違います/)
})

test('trace lists what a principle reaches and rejects an unknown start', () => {
  const repo = fresh('hig')
  const r = trace(repo, 'P3')
  assert.ok(r.affected.some((a) => a.where.includes('D1')))
  assert.ok(r.affected.some((a) => a.where.includes('color.label')))
  assert.ok(r.affected.some((a) => a.outputs?.swiftui === 'DSInlineMessage'))
  assert.throws(() => trace(repo, 'P99'), /原則の ID にもトークンにもありません/)
})

test('the command line prints JSON and exits 1 with a message on a bad call', () => {
  const repo = tempRepo({ 'a.txt': '' })
  const ok = spawnSync(process.execPath, [CLI, 'install', repo, '--base', 'shadcn'], { encoding: 'utf8' })
  assert.equal(ok.status, 0)
  assert.equal(JSON.parse(ok.stdout).base, 'shadcn')
  const bad = spawnSync(process.execPath, [CLI, 'nothing', repo], { encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /使い方/)
})
