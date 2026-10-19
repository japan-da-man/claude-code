import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanMock, prepareMock, shootCommand } from '../line/mock.js'

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

test('shooting runs the app\'s own design-system/shoot.mjs in the mock worktree, light only', () => {
  const { root, repo } = repoWithDesignSystem()
  const m = prepareMock({ repo, id: '20261019-share', workRoot: join(root, 'work'), outDir: join(root, 'ui') })
  writeFileSync(join(m.dir, 'design-system', 'shoot.mjs'), '// vendored\n')
  const c = shootCommand({ dir: m.dir, pages: ['factory-mock-a', 'factory-mock-a', 'factory-mock-b'], out: '/o' })
  assert.deepEqual(c, { cmd: process.execPath, args: ['design-system/shoot.mjs', '--pages', 'factory-mock-a,factory-mock-b', '--appearance', 'light', '--out', '/o'], cwd: m.dir })
  cleanMock({ repo, dir: m.dir })
})

test('an app whose design system predates shoot.mjs is told to update it', () => {
  const { root, repo } = repoWithDesignSystem()
  const m = prepareMock({ repo, id: '20261019-share', workRoot: join(root, 'work'), outDir: join(root, 'ui') })
  assert.throws(() => shootCommand({ dir: m.dir, pages: ['factory-mock-a'], out: '/o' }), /design-system:update/)
  cleanMock({ repo, dir: m.dir })
})
