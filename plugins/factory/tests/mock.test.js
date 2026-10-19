import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanMock, mockShotPlan, prepareMock } from '../line/mock.js'

function repoWithDesignSystem() {
  const root = mkdtempSync(join(tmpdir(), 'factory-mock-'))
  const origin = join(root, 'origin.git')
  const repo = join(root, 'repo')
  execSync(`git init -q --bare -b main ${origin}`)
  mkdirSync(join(repo, 'design-system'), { recursive: true })
  mkdirSync(join(repo, 'App', 'DesignSystem', 'Catalog'), { recursive: true })
  writeFileSync(
    join(repo, 'design-system', 'design-system.json'),
    JSON.stringify({ ios: { code: 'App/DesignSystem', sources: ['App'] }, protected_paths: ['design-system/**'] }),
  )
  writeFileSync(join(repo, 'App', 'DesignSystem', 'Catalog', 'DesignSystemCatalog.swift'), '// catalog\n')
  const git = (args) => execSync(`git ${args}`, { cwd: repo, stdio: 'ignore' })
  git('init -q -b main')
  git('config user.email t@example.com')
  git('config user.name t')
  git('add -A')
  git('commit -q -m init')
  git(`remote add origin ${origin}`)
  git('push -q -u origin main')
  return { root, repo }
}

test('prepareMock makes a throwaway worktree from origin and says where mocks go', () => {
  const { root, repo } = repoWithDesignSystem()
  const m = prepareMock({ repo, id: '20261019-share', workRoot: join(root, 'work'), outDir: join(root, 'ui') })
  assert.ok(existsSync(join(m.dir, 'App', 'DesignSystem', 'Catalog', 'DesignSystemCatalog.swift')))
  assert.equal(m.mocks, join(m.dir, 'App', 'FactoryMocks'))
  assert.equal(m.catalog, join(m.dir, 'App', 'DesignSystem', 'Catalog', 'DesignSystemCatalog.swift'))
  assert.equal(m.out, join(root, 'ui'))
  // 手元のチェックアウトのブランチは増えない（detached の worktree）
  assert.equal(execSync('git branch --list', { cwd: repo, encoding: 'utf8' }).trim(), '* main')
  cleanMock({ repo, dir: m.dir })
  assert.equal(existsSync(m.dir), false)
})

test('prepareMock refuses an app without a design system', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-mock-'))
  assert.throws(() => prepareMock({ repo: root, id: '20261019-share', workRoot: join(root, 'work'), outDir: join(root, 'ui') }), /design-system/)
})

test('the shot plan builds once and shoots each mock page in light mode', () => {
  const config = { ios: { project: 'App.xcodeproj', scheme: 'App', bundle_id: 'com.example.App' } }
  const steps = mockShotPlan({ config, dir: '/m', udid: 'U', derived: '/d', out: '/o', pages: ['factory-mock-a', 'factory-mock-b'], xcodegen: true })
  const cmds = steps.map((s) => s.cmd ?? (s.shot ? 'shot' : 'sleep'))
  assert.equal(cmds[0], 'xcodegen')
  assert.equal(steps.filter((s) => s.cmd === 'xcodebuild').length, 1)
  const shots = steps.filter((s) => s.shot).map((s) => s.shot)
  assert.deepEqual(shots, ['/o/factory-mock-a.png', '/o/factory-mock-b.png'])
  const launches = steps.filter((s) => s.cmd === 'xcrun' && s.args[1] === 'launch' && s.args.includes('-DesignSystemCatalog'))
  assert.deepEqual(launches.map((s) => s.args.at(-1)), ['factory-mock-a', 'factory-mock-b'])
  assert.ok(steps.some((s) => s.cmd === 'xcrun' && s.args.includes('appearance') && s.args.includes('light')))
})
