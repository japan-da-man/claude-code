import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { cleanMock, looksBlank, mockShotPlan, prepareMock, shootSettled } from '../line/mock.js'

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

test('each page is shot once even if named twice, and only after the screen settles', () => {
  const config = { ios: { project: 'App.xcodeproj', scheme: 'App', bundle_id: 'com.example.App' } }
  const steps = mockShotPlan({ config, dir: '/m', udid: 'U', derived: '/d', out: '/o', pages: ['factory-mock-a', 'factory-mock-a', 'factory-mock-b'], xcodegen: false })
  const shots = steps.filter((s) => s.shot)
  assert.deepEqual(shots.map((s) => s.shot), ['/o/factory-mock-a.png', '/o/factory-mock-b.png'])
  assert.ok(shots.every((s) => s.settle === true))
})

test('a settling shot keeps shooting until two shots in a row are identical', () => {
  const frames = ['fade-1', 'fade-2', 'final', 'final']
  let i = 0
  const written = []
  const result = shootSettled({ shot: '/o/a.png', udid: 'U' }, {
    capture: (path) => written.push(path),
    read: () => frames[Math.min(i++, frames.length - 1)],
    sleep: () => {},
  })
  assert.equal(result.settled, true)
  assert.equal(i, 4)
})

test('a screen that never settles is reported, not silently kept', () => {
  let i = 0
  const result = shootSettled({ shot: '/o/a.png', udid: 'U' }, { capture: () => {}, read: () => `frame-${i++}`, sleep: () => {} })
  assert.equal(result.settled, false)
})

// テスト用に、グレースケールの PNG を作る（行ごとに値を決める）
function png(width, height, rowValue) {
  const crc = (buf) => {
    let c = ~0
    for (const b of buf) {
      c ^= b
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
    }
    return ~c >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.alloc(width, rowValue(y))])))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

test('a screen that is blank below the status bar is recognised as blank', () => {
  const blank = png(40, 100, (y) => (y < 10 ? 0 : 255))
  const content = png(40, 100, (y) => (y < 10 ? 0 : (y * 7) % 256))
  assert.equal(looksBlank(blank), true)
  assert.equal(looksBlank(content), false)
  assert.equal(looksBlank(Buffer.from('not a png')), false)
})

test('two identical blank shots in a row are not a settled screen', () => {
  const blank = png(40, 100, (y) => (y < 10 ? 0 : 255))
  const content = png(40, 100, (y) => (y < 10 ? 0 : (y * 7) % 256))
  const frames = [blank, blank, blank, content, content]
  let i = 0
  const result = shootSettled({ shot: '/o/a.png', udid: 'U' }, { capture: () => {}, read: () => frames[Math.min(i++, frames.length - 1)], sleep: () => {} })
  assert.equal(result.settled, true)
  assert.equal(i, 5)
})
